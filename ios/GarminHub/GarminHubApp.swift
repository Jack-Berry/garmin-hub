import SwiftUI

@main
struct GarminHubApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            Group {
                if settings.apiKey.isEmpty {
                    NavigationStack { SettingsView(firstRun: true) }
                        .environmentObject(settings)
                        .preferredColorScheme(.dark)
                } else {
                    DashboardScreen()
                        .environmentObject(settings)
                }
            }
            .onAppear {
                PushNotifications.shared.configure(apiKey: settings.apiKey)
                HealthKitSync.shared.configure(apiKey: settings.apiKey)
            }
            .onChange(of: settings.apiKey) { _, key in
                PushNotifications.shared.configure(apiKey: key)
                HealthKitSync.shared.configure(apiKey: key)
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { HealthKitSync.shared.appBecameActive(apiKey: settings.apiKey) }
            }
        }
    }
}
