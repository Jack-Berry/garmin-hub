import CoreLocation
import Foundation
import HealthKit

private struct HealthWorkoutPayload: Codable {
    struct Coordinate: Codable { let latitude: Double; let longitude: Double }
    let uuid: String
    let activityType: UInt
    let start: Date
    let end: Date
    let duration: Double
    let distance: Double?
    let energy: Double?
    let averageHR: Double?
    let maxHR: Double?
    let routeStart: Coordinate?
    let splits: [HealthSplit]
}

private struct HealthWorkoutBatch: Codable { let workouts: [HealthWorkoutPayload] }

@MainActor
final class HealthKitSync {
    static let shared = HealthKitSync()
    private let store = HKHealthStore()
    private let anchorKey = "healthWorkoutAnchor"
    private var apiKey = ""
    private var observer: HKObserverQuery?
    private var syncGate = HealthSyncGate()

    func configure(apiKey: String) {
        guard HKHealthStore.isHealthDataAvailable(),
              HealthAuthorizationGate.shouldRequest(apiKey: apiKey) else { return }
        self.apiKey = apiKey
        Task {
            do {
                try await requestAccess()
                installObserver()
                try await sync()
            } catch {
                print("HealthKit setup failed: \(error.localizedDescription)")
            }
        }
    }

    func appBecameActive(apiKey: String) {
        guard !apiKey.isEmpty else { return }
        self.apiKey = apiKey
        Task {
            do { try await sync() }
            catch { print("HealthKit sync failed: \(error.localizedDescription)") }
        }
    }

    private var readTypes: Set<HKObjectType> {
        [
            HKObjectType.workoutType(),
            HKObjectType.quantityType(forIdentifier: .heartRate)!,
            HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning)!,
            HKSeriesType.workoutRoute(),
            HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!,
        ]
    }

    private func requestAccess() async throws {
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    private func installObserver() {
        guard HealthObserverGate.shouldInstall(hasObserver: observer != nil) else { return }
        let type = HKObjectType.workoutType()
        let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, completion, error in
            guard error == nil, let self else { completion(); return }
            Task { @MainActor in
                do { try await self.sync() }
                catch { print("HealthKit background sync failed: \(error.localizedDescription)") }
                completion()
            }
        }
        observer = query
        store.execute(query)
        store.enableBackgroundDelivery(for: type, frequency: .immediate) { success, error in
            if !success { print("HealthKit background delivery failed: \(error?.localizedDescription ?? "unknown error")") }
        }
    }

    private func sync() async throws {
        guard !apiKey.isEmpty else { return }
        guard syncGate.begin() else { return }
        defer {
            if syncGate.finish() { Task { try? await sync() } }
        }

        let result = try await anchoredWorkouts()
        let watchWorkouts = result.workouts.filter(Self.isAppleWatchWorkout)
        var payloads: [HealthWorkoutPayload] = []
        for workout in watchWorkouts { payloads.append(try await payload(for: workout)) }
        var confirmedUploads = 0
        for start in stride(from: 0, to: payloads.count, by: 50) {
            let batch = Array(payloads[start..<min(start + 50, payloads.count)])
            try await post(batch)
            confirmedUploads += batch.count
        }
        if HealthAnchorGate.shouldSave(uploadCount: payloads.count, confirmedUploads: confirmedUploads) {
            saveAnchor(result.anchor)
        }
    }

    private static func isAppleWatchWorkout(_ workout: HKWorkout) -> Bool {
        let revision = workout.sourceRevision
        return HealthWorkoutSource.isAppleWatch(
            productType: revision.productType,
            bundleIdentifier: revision.source.bundleIdentifier
        )
    }

    private func anchoredWorkouts() async throws -> (workouts: [HKWorkout], anchor: HKQueryAnchor) {
        let anchor = loadAnchor()
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: HKObjectType.workoutType(), predicate: nil, anchor: anchor,
                limit: HKObjectQueryNoLimit
            ) { _, samples, _, newAnchor, error in
                if let error { continuation.resume(throwing: error); return }
                guard let newAnchor else {
                    continuation.resume(throwing: URLError(.cannotParseResponse)); return
                }
                continuation.resume(returning: (samples as? [HKWorkout] ?? [], newAnchor))
            }
            store.execute(query)
        }
    }

    private func payload(for workout: HKWorkout) async throws -> HealthWorkoutPayload {
        async let distanceSamples = quantitySamples(.distanceWalkingRunning, workout: workout)
        async let heartSamples = quantitySamples(.heartRate, workout: workout)
        async let routeStart = firstRouteCoordinate(workout)
        let distances = try await distanceSamples
        let hearts = try await heartSamples
        let rates = hearts.map {
            HealthRatePoint(date: $0.startDate, bpm: $0.quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute())))
        }
        let splits = HealthSplitBuilder.build(
            distanceSegments: distances.map {
                HealthDistanceSegment(
                    start: $0.startDate, end: $0.endDate,
                    metres: $0.quantity.doubleValue(for: .meter())
                )
            },
            heartRates: rates,
            workoutStart: workout.startDate,
            workoutEnd: workout.endDate
        )
        let coordinate = try await routeStart
        let totalDistance = distances.reduce(0) { $0 + $1.quantity.doubleValue(for: .meter()) }
        let totalEnergy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?
            .sumQuantity()?.doubleValue(for: .kilocalorie())
        return HealthWorkoutPayload(
            uuid: workout.uuid.uuidString,
            activityType: workout.workoutActivityType.rawValue,
            start: workout.startDate,
            end: workout.endDate,
            duration: workout.duration,
            distance: totalDistance > 0 ? totalDistance : nil,
            energy: totalEnergy,
            averageHR: rates.isEmpty ? nil : rates.map(\.bpm).reduce(0, +) / Double(rates.count),
            maxHR: rates.map(\.bpm).max(),
            routeStart: coordinate.map { .init(latitude: $0.latitude, longitude: $0.longitude) },
            splits: splits
        )
    }

    private func quantitySamples(_ identifier: HKQuantityTypeIdentifier, workout: HKWorkout) async throws -> [HKQuantitySample] {
        let type = HKQuantityType(identifier)
        return try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: type,
                predicate: HKQuery.predicateForObjects(from: workout),
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
            ) { _, samples, error in
                if let error { continuation.resume(throwing: error); return }
                continuation.resume(returning: samples as? [HKQuantitySample] ?? [])
            }
            store.execute(query)
        }
    }

    private func firstRouteCoordinate(_ workout: HKWorkout) async throws -> CLLocationCoordinate2D? {
        let route: HKWorkoutRoute? = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(
                sampleType: HKSeriesType.workoutRoute(),
                predicate: HKQuery.predicateForObjects(from: workout),
                limit: 1,
                sortDescriptors: nil
            ) { _, samples, error in
                if let error { continuation.resume(throwing: error); return }
                continuation.resume(returning: samples?.first as? HKWorkoutRoute)
            }
            store.execute(query)
        }
        guard let route else { return nil }
        return try await withCheckedThrowingContinuation { continuation in
            var first: CLLocationCoordinate2D?
            let query = HKWorkoutRouteQuery(route: route) { _, locations, done, error in
                if let error { continuation.resume(throwing: error); return }
                if first == nil { first = locations?.first?.coordinate }
                if done { continuation.resume(returning: first) }
            }
            store.execute(query)
        }
    }

    private func post(_ workouts: [HealthWorkoutPayload]) async throws {
        guard !workouts.isEmpty else { return }
        var request = URLRequest(url: HubConfiguration.url("api/health/workouts"))
        request.httpMethod = "POST"
        request.timeoutInterval = HealthRequestPolicy.timeout
        request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        request.httpBody = try encoder.encode(HealthWorkoutBatch(workouts: workouts))
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    private func loadAnchor() -> HKQueryAnchor? {
        guard let data = UserDefaults.standard.data(forKey: anchorKey) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
    }

    private func saveAnchor(_ anchor: HKQueryAnchor) {
        guard let data = try? NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true) else { return }
        UserDefaults.standard.set(data, forKey: anchorKey)
    }
}
