import Foundation

enum HubConfiguration {
    static let host = "hub.berrydev.co.uk"
    static let baseURL = URL(string: "https://\(host)")!

    static func url(_ path: String) -> URL {
        baseURL.appending(path: path)
    }
}
