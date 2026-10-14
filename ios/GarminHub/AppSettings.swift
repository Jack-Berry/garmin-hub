import Foundation

@MainActor
final class AppSettings: ObservableObject {
    @Published private(set) var apiKey: String
    private let keychain = KeychainStore()

    init() {
        apiKey = keychain.readKey()
    }

    func save(_ value: String) throws {
        let key = value.trimmingCharacters(in: .whitespacesAndNewlines)
        try keychain.saveKey(key)
        apiKey = key
    }
}
