import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var settings: AppSettings
    @Environment(\.dismiss) private var dismiss
    let firstRun: Bool
    @State private var key = ""
    @State private var error: String?

    var body: some View {
        Form {
            Section("Connection") {
                SecureField("API key", text: $key)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text("Use the API_SECRET configured on \(HubConfiguration.host).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error { Text(error).foregroundStyle(.red) }
            Button("Save") {
                do {
                    try settings.save(key)
                    if !firstRun { dismiss() }
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .navigationTitle(firstRun ? "Connect Garmin Hub" : "Settings")
        .onAppear { key = settings.apiKey }
    }
}
