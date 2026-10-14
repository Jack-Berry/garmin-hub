import SwiftUI
import WebKit

struct DashboardWebView: UIViewRepresentable {
    let apiKey: String
    let onFailure: (String) -> Void
    let onOpenSettings: () -> Void
    let onThemeChange: (Bool) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onFailure: onFailure,
            onOpenSettings: onOpenSettings,
            onThemeChange: onThemeChange
        )
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(HubSchemeHandler(apiKey: apiKey), forURLScheme: "hub")
        config.userContentController.add(context.coordinator, name: "garminHub")
        let literal = String(data: try! JSONSerialization.data(withJSONObject: apiKey, options: .fragmentsAllowed), encoding: .utf8)!
        config.userContentController.addUserScript(WKUserScript(
            source: "window.__GARMIN_HUB_APP__ = true; window.__HUB_API_KEY__ = \(literal);",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 11 / 255, green: 11 / 255, blue: 13 / 255, alpha: 1)
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        context.coordinator.webView = webView
        webView.load(URLRequest(url: URL(string: "hub://dashboard/")!))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "garminHub")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        let onFailure: (String) -> Void
        let onOpenSettings: () -> Void
        let onThemeChange: (Bool) -> Void

        init(
            onFailure: @escaping (String) -> Void,
            onOpenSettings: @escaping () -> Void,
            onThemeChange: @escaping (Bool) -> Void
        ) {
            self.onFailure = onFailure
            self.onOpenSettings = onOpenSettings
            self.onThemeChange = onThemeChange
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            let origin = message.frameInfo.securityOrigin
            guard message.frameInfo.isMainFrame,
                  origin.protocol == "hub",
                  origin.host == "dashboard",
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            if action == "openSettings" {
                onOpenSettings()
            } else if action == "theme", let dark = body["dark"] as? Bool {
                onThemeChange(dark)
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as? URLError)?.code == .cancelled { return }
            onFailure("The dashboard could not be loaded. Check the droplet and try again.")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as? URLError)?.code == .cancelled { return }
            onFailure("The dashboard could not be reached. Check your connection and try again.")
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url else { decisionHandler(.cancel); return }
            if url.scheme == "hub" { decisionHandler(.allow); return }
            if url.scheme == "https" || url.scheme == "http" { UIApplication.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
}

final class HubSchemeHandler: NSObject, WKURLSchemeHandler {
    private let apiKey: String
    private let lock = NSLock()
    private var tasks: [ObjectIdentifier: URLSessionDataTask] = [:]

    init(apiKey: String) { self.apiKey = apiKey }

    func webView(_ webView: WKWebView, start schemeTask: WKURLSchemeTask) {
        guard let incoming = schemeTask.request.url,
              var parts = URLComponents(url: incoming, resolvingAgainstBaseURL: false) else {
            schemeTask.didFailWithError(URLError(.badURL)); return
        }
        parts.scheme = "https"
        parts.host = "hub.berrydev.co.uk"
        guard let remote = parts.url else { schemeTask.didFailWithError(URLError(.badURL)); return }
        var request = URLRequest(url: remote)
        request.httpMethod = schemeTask.request.httpMethod
        do {
            request.httpBody = try Self.bodyData(from: schemeTask.request)
        } catch {
            schemeTask.didFailWithError(error)
            return
        }
        for (name, value) in schemeTask.request.allHTTPHeaderFields ?? [:] {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue(apiKey, forHTTPHeaderField: "X-Api-Key")
        let identifier = ObjectIdentifier(schemeTask)
        let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard self?.finish(identifier) == true else { return }
            if let error { schemeTask.didFailWithError(error); return }
            guard let http = response as? HTTPURLResponse else {
                schemeTask.didFailWithError(URLError(.badServerResponse)); return
            }
            let local = HTTPURLResponse(
                url: incoming,
                statusCode: http.statusCode,
                httpVersion: "HTTP/1.1",
                headerFields: http.allHeaderFields.reduce(into: [String: String]()) {
                    $0[String(describing: $1.key)] = String(describing: $1.value)
                }
            )!
            schemeTask.didReceive(local)
            if let data { schemeTask.didReceive(data) }
            schemeTask.didFinish()
        }
        lock.lock(); tasks[identifier] = task; lock.unlock()
        task.resume()
    }

    func webView(_ webView: WKWebView, stop schemeTask: WKURLSchemeTask) {
        let identifier = ObjectIdentifier(schemeTask)
        lock.lock(); let task = tasks.removeValue(forKey: identifier); lock.unlock()
        task?.cancel()
    }

    private func finish(_ identifier: ObjectIdentifier) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return tasks.removeValue(forKey: identifier) != nil
    }

    private static func bodyData(from request: URLRequest) throws -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }

        stream.open()
        defer { stream.close() }
        var body = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count == 0 { return body }
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
            body.append(buffer, count: count)
        }
    }
}
