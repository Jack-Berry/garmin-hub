import Foundation

struct HealthDistanceSegment {
    let start: Date
    let end: Date
    let metres: Double
}

struct HealthRatePoint {
    let date: Date
    let bpm: Double
}

struct HealthSplit: Codable, Equatable {
    let distance: Double
    let duration: Double
    let averageHR: Double?
    let averageSpeed: Double
}

enum HealthSplitBuilder {
    static func build(
        distanceSegments: [HealthDistanceSegment],
        heartRates: [HealthRatePoint],
        workoutStart: Date,
        workoutEnd: Date
    ) -> [HealthSplit] {
        var splits: [HealthSplit] = []
        var splitStart = workoutStart
        var splitDistance = 0.0

        func appendSplit(end: Date, distance: Double) {
            let seconds = end.timeIntervalSince(splitStart)
            guard distance > 0, seconds > 0 else { return }
            let rates = heartRates.filter { $0.date >= splitStart && $0.date < end }.map(\.bpm)
            let average = rates.isEmpty ? nil : rates.reduce(0, +) / Double(rates.count)
            splits.append(HealthSplit(
                distance: distance,
                duration: seconds,
                averageHR: average,
                averageSpeed: distance / seconds
            ))
            splitStart = end
        }

        for segment in distanceSegments.sorted(by: { $0.start < $1.start }) where segment.metres > 0 {
            var cursor = max(segment.start, splitStart)
            var remaining = segment.metres
            while splitDistance + remaining >= 1000 {
                let needed = 1000 - splitDistance
                let fraction = needed / remaining
                let boundary = cursor.addingTimeInterval(segment.end.timeIntervalSince(cursor) * fraction)
                appendSplit(end: boundary, distance: 1000)
                splitDistance = 0
                remaining -= needed
                cursor = boundary
            }
            splitDistance += remaining
        }

        if splitDistance > 0 { appendSplit(end: workoutEnd, distance: splitDistance) }
        return splits
    }
}

enum HealthWorkoutSource {
    static func isAppleWatch(productType: String?, bundleIdentifier: String) -> Bool {
        let product = productType?.lowercased() ?? ""
        let bundle = bundleIdentifier.lowercased()
        return product.hasPrefix("watch")
            || bundle.hasPrefix("com.apple.nanoworkout")
    }
}

enum HealthAuthorizationGate {
    static func shouldRequest(apiKey: String) -> Bool { !apiKey.isEmpty }
}

enum HealthRequestPolicy {
    static let timeout: TimeInterval = 30
}

enum HealthAnchorGate {
    static func shouldSave(uploadCount: Int, confirmedUploads: Int) -> Bool {
        uploadCount == confirmedUploads
    }
}

struct HealthSyncGate {
    private(set) var isRunning = false
    private(set) var hasPendingRun = false

    mutating func begin() -> Bool {
        if isRunning { hasPendingRun = true; return false }
        isRunning = true
        return true
    }

    mutating func finish() -> Bool {
        isRunning = false
        let rerun = hasPendingRun
        hasPendingRun = false
        return rerun
    }
}

enum HealthObserverGate {
    static func shouldInstall(hasObserver: Bool) -> Bool { !hasObserver }
}
