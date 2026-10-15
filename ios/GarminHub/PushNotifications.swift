import Foundation
import UIKit
import UserNotifications

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        if let payload = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
            PushNotifications.shared.pendingPayload = payload
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotifications.shared.register(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushNotifications.shared.registrationFailed()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        PushNotifications.shared.open(response.notification.request.content.userInfo)
        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}

@MainActor
final class PushNotifications: ObservableObject {
    static let shared = PushNotifications()
    @Published var deviceToken = UserDefaults.standard.string(forKey: "pushDeviceToken")
    @Published var permission = "unknown"
    var pendingPayload: [AnyHashable: Any]?
    var onOpen: (([String: Any]) -> Void)?
    var onState: ((String, String) -> Void)?
    private var apiKey = ""

    func configure(apiKey: String) {
        guard !apiKey.isEmpty else { return }
        self.apiKey = apiKey
        Task {
            let center = UNUserNotificationCenter.current()
            let settings = await center.notificationSettings()
            var allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            if settings.authorizationStatus == .notDetermined {
                allowed = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true
            }
            permission = allowed ? "granted" : "denied"
            onState?(deviceToken ?? "", permission)
            if allowed { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func register(deviceToken data: Data) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = token
        UserDefaults.standard.set(token, forKey: "pushDeviceToken")
        onState?(token, permission)
        guard !apiKey.isEmpty else { return }
        var request = URLRequest(url: HubConfiguration.url("api/notifications/device"))
        request.httpMethod = "POST"
        request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["token": token, "platform": "ios"])
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            let ok = error == nil && (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } == true
            guard !ok else { return }
            Task { @MainActor in self?.registrationFailed() }
        }.resume()
    }

    func registrationFailed() {
        permission = "registration_failed"
        onState?(deviceToken ?? "", permission)
    }

    func open(_ payload: [AnyHashable: Any]) {
        let safe = payload.reduce(into: [String: Any]()) { result, item in
            if let key = item.key as? String { result[key] = item.value }
        }
        if let onOpen { onOpen(safe) } else { pendingPayload = payload }
    }
}
