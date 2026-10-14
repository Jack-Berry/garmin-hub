import SwiftUI

@main
struct GarminHubApp: App {
    @StateObject private var settings = AppSettings()

    var body: some Scene {
        WindowGroup {
            Group {
                if settings.apiKey.isEmpty {
                    NavigationStack { SettingsView(firstRun: true) }
                        .environmentObject(settings)
                } else {
                    DashboardScreen()
                        .environmentObject(settings)
                }
            }
            .preferredColorScheme(.dark)
        }
    }
}
