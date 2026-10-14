import SwiftUI

struct DashboardScreen: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var state: LoadState = .checking
    @State private var showingSettings = false
    @State private var webDark = true

    enum LoadState: Equatable {
        case checking
        case ready
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .checking:
                    ProgressView("Connecting...")
                case .ready:
                    DashboardWebView(
                        apiKey: settings.apiKey,
                        onFailure: { state = .failed($0) },
                        onOpenSettings: { showingSettings = true },
                        onThemeChange: { webDark = $0 }
                    )
                    .id(settings.apiKey)
                    .ignoresSafeArea()
                case .failed(let message):
                    ContentUnavailableView {
                        Label("Dashboard unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try Again") { Task { await connect() } }
                        Button("Check API Key") { showingSettings = true }
                    }
                }
            }
            .navigationTitle("Garmin Hub")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(state == .ready ? .hidden : .visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gearshape") { showingSettings = true }
                }
            }
            .sheet(isPresented: $showingSettings, onDismiss: {
                Task { await connect() }
            }) {
                NavigationStack { SettingsView(firstRun: false) }
                    .environmentObject(settings)
            }
        }
        .background(Color(red: 11 / 255, green: 11 / 255, blue: 13 / 255))
        .preferredColorScheme(webDark ? .dark : .light)
        .task { await connect() }
    }

    private func connect() async {
        state = .checking
        var request = URLRequest(url: URL(string: "https://hub.berrydev.co.uk/api/health")!)
        request.setValue(settings.apiKey, forHTTPHeaderField: "X-Api-Key")
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                state = .failed("The server returned an invalid response.")
                return
            }
            if http.statusCode == 401 {
                state = .failed("The API key is missing or incorrect.")
            } else if (200..<300).contains(http.statusCode) {
                state = .ready
            } else {
                state = .failed("The server returned HTTP \(http.statusCode).")
            }
        } catch {
            state = .failed("The droplet could not be reached. Check your connection and try again.")
        }
    }
}
