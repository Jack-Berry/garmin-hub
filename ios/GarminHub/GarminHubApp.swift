import SwiftUI

@main
struct GarminHubApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
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
            .onAppear { PushNotifications.shared.configure(apiKey: settings.apiKey) }
            .onChange(of: settings.apiKey) { _, key in
                PushNotifications.shared.configure(apiKey: key)
            }
        }
    }
}
