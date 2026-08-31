import SwiftUI
import WebKit

/// Pixels only. User interaction is off so noVNC cannot steal gestures or send RFB pointer.
struct VncView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: cfg)
        view.isUserInteractionEnabled = false
        view.scrollView.isScrollEnabled = false
        view.scrollView.pinchGestureRecognizer?.isEnabled = false
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        uiView.isUserInteractionEnabled = false
        if uiView.url != url {
            uiView.load(URLRequest(url: url))
        }
    }
}
