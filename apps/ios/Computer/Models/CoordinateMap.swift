import CoreGraphics

enum CoordinateMap {
    static let width: CGFloat = 1280
    static let height: CGFloat = 800

    /// Letterbox 1280×800 into `bounds`. Origin top-left, same sentence as the agent.
    static func desktopPoint(from view: CGPoint, in bounds: CGRect) -> (x: Int, y: Int) {
        let scale = min(bounds.width / width, bounds.height / height)
        let w = width * scale
        let h = height * scale
        let x0 = bounds.minX + (bounds.width - w) / 2
        let y0 = bounds.minY + (bounds.height - h) / 2
        let x = (view.x - x0) / scale
        let y = (view.y - y0) / scale
        let px = Int(min(width - 1, max(0, x.rounded())))
        let py = Int(min(height - 1, max(0, y.rounded())))
        return (px, py)
    }

    static func viewPoint(from desktop: (x: Int, y: Int), in bounds: CGRect) -> CGPoint {
        let scale = min(bounds.width / width, bounds.height / height)
        let w = width * scale
        let h = height * scale
        let x0 = bounds.minX + (bounds.width - w) / 2
        let y0 = bounds.minY + (bounds.height - h) / 2
        return CGPoint(x: x0 + CGFloat(desktop.x) * scale, y: y0 + CGFloat(desktop.y) * scale)
    }
}
