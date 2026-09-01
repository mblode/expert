import SwiftUI
import WebKit

/// Pixels only. User interaction is off so noVNC cannot steal gestures or send RFB pointer.
struct VncView: UIViewRepresentable {
    let url: URL
    /// Bumped by `AppModel.retry()` to load again after a failure.
    var reloadToken: Int = 0
    /// The load failed or the renderer died. Without this a dead renderer is
    /// indistinguishable from a desktop that happens to be black.
    var onFailure: (String) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        // The seat token rides in the query string, so nothing about this page
        // is allowed to outlive the session on disk.
        cfg.websiteDataStore = .nonPersistent()
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.navigationDelegate = context.coordinator
        view.isUserInteractionEnabled = false
        view.scrollView.isScrollEnabled = false
        view.scrollView.pinchGestureRecognizer?.isEnabled = false
        // A webview that has not painted yet is white; the desktop behind it is
        // black, and a white flash reads as the failure it is not.
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        context.coordinator.load(view, url: url, token: reloadToken)
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.parent = self
        uiView.isUserInteractionEnabled = false
        context.coordinator.load(uiView, url: url, token: reloadToken)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: VncView
        private var loaded: URL?
        private var token = -1

        init(_ parent: VncView) { self.parent = parent }

        /// Tracks what was asked for rather than `webView.url`, which goes nil
        /// on a failed load and would otherwise reload on every layout pass.
        func load(_ webView: WKWebView, url: URL, token: Int) {
            guard loaded != url || self.token != token else { return }
            loaded = url
            self.token = token
            webView.load(URLRequest(url: url))
        }

        /// The hub serves noVNC over the tailnet; nothing else gets to navigate
        /// this view, and no scheme handler gets to leave it.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction
        ) async -> WKNavigationActionPolicy {
            let target = navigationAction.request.url
            let sameOrigin = target?.host == loaded?.host && target?.scheme == loaded?.scheme
            return sameOrigin ? .allow : .cancel
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation: WKNavigation!, withError error: Error) {
            parent.onFailure(error.localizedDescription)
        }

        func webView(_ webView: WKWebView, didFail: WKNavigation!, withError error: Error) {
            parent.onFailure(error.localizedDescription)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            parent.onFailure("the desktop view crashed")
        }
    }
}
