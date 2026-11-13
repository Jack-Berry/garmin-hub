import XCTest
@testable import Garmin_Hub

final class HealthSplitBuilderTests: XCTestCase {
    func testFullKilometresAndFinalPartialSplit() {
        let start = Date(timeIntervalSince1970: 0)
        let splits = HealthSplitBuilder.build(
            distanceSegments: [
                .init(start: start, end: start.addingTimeInterval(300), metres: 1000),
                .init(start: start.addingTimeInterval(300), end: start.addingTimeInterval(660), metres: 1200),
            ],
            heartRates: [
                .init(date: start.addingTimeInterval(100), bpm: 140),
                .init(date: start.addingTimeInterval(400), bpm: 160),
            ],
            workoutStart: start,
            workoutEnd: start.addingTimeInterval(660)
        )
        XCTAssertEqual(splits.map(\.distance), [1000, 1000, 200])
        XCTAssertEqual(splits[0].duration, 300, accuracy: 0.001)
        XCTAssertEqual(splits[1].duration, 300, accuracy: 0.001)
        XCTAssertEqual(splits[2].duration, 60, accuracy: 0.001)
        XCTAssertEqual(splits[0].averageHR, 140)
        XCTAssertEqual(splits[1].averageHR, 160)
        XCTAssertEqual(splits[2].averageSpeed, 200 / 60, accuracy: 0.001)
    }

    func testAppleWatchSourceFilterExcludesThirdPartyWriters() {
        XCTAssertTrue(HealthWorkoutSource.isAppleWatch(
            productType: "Watch7,4", bundleIdentifier: "com.example.workout"))
        XCTAssertTrue(HealthWorkoutSource.isAppleWatch(
            productType: nil, bundleIdentifier: "com.apple.NanoWorkout"))
        XCTAssertFalse(HealthWorkoutSource.isAppleWatch(
            productType: "iPhone18,1", bundleIdentifier: "com.apple.health"))
        XCTAssertFalse(HealthWorkoutSource.isAppleWatch(
            productType: "iPhone18,1", bundleIdentifier: "com.garmin.connect.mobile"))
        XCTAssertFalse(HealthWorkoutSource.isAppleWatch(
            productType: nil, bundleIdentifier: "com.strava.stravaride"))
    }

    func testAnchorOnlySavesAfterEveryUploadIsConfirmed() {
        XCTAssertTrue(HealthAnchorGate.shouldSave(uploadCount: 50, confirmedUploads: 50))
        XCTAssertFalse(HealthAnchorGate.shouldSave(uploadCount: 50, confirmedUploads: 49))
    }

    func testConcurrentSyncQueuesOneFollowUpAndObserverInstallsOnce() {
        var gate = HealthSyncGate()
        XCTAssertTrue(gate.begin())
        XCTAssertFalse(gate.begin())
        XCTAssertTrue(gate.finish())
        XCTAssertFalse(gate.finish())
        XCTAssertTrue(HealthObserverGate.shouldInstall(hasObserver: false))
        XCTAssertFalse(HealthObserverGate.shouldInstall(hasObserver: true))
    }

    func testAuthorizationWaitsForApiKeyAndRequestsHaveATimeout() {
        XCTAssertFalse(HealthAuthorizationGate.shouldRequest(apiKey: ""))
        XCTAssertTrue(HealthAuthorizationGate.shouldRequest(apiKey: "configured"))
        XCTAssertEqual(HealthRequestPolicy.timeout, 30)
    }
}
