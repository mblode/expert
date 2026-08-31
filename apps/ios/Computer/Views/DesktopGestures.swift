import SwiftUI
import UIKit

/// UIKit recognizers so two-finger scroll and press-hold right-click
/// do not fight SwiftUI's exclusive gestures.
struct DesktopGestures: UIViewRepresentable {
    var seat: SeatController
    var enabled: Bool

    func makeUIView(context: Context) -> GestureView {
        let v = GestureView()
        v.seat = seat
        v.isUserInteractionEnabled = enabled
        return v
    }

    func updateUIView(_ uiView: GestureView, context: Context) {
        uiView.seat = seat
        uiView.isUserInteractionEnabled = enabled
    }

    final class GestureView: UIView, UIGestureRecognizerDelegate {
        var seat: SeatController?
        private var lastTwo: CGPoint?

        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = .clear
            isMultipleTouchEnabled = true

            let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
            tap.numberOfTouchesRequired = 1
            addGestureRecognizer(tap)

            let rightTap = UITapGestureRecognizer(target: self, action: #selector(onRightTap(_:)))
            rightTap.numberOfTouchesRequired = 2
            addGestureRecognizer(rightTap)

            let hold = UILongPressGestureRecognizer(target: self, action: #selector(onHold(_:)))
            hold.minimumPressDuration = 0.45
            addGestureRecognizer(hold)

            let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
            pan.minimumNumberOfTouches = 1
            pan.maximumNumberOfTouches = 1
            addGestureRecognizer(pan)

            let two = UIPanGestureRecognizer(target: self, action: #selector(onTwoPan(_:)))
            two.minimumNumberOfTouches = 2
            two.maximumNumberOfTouches = 2
            addGestureRecognizer(two)

            [tap, rightTap, hold, pan, two].forEach { $0.delegate = self }
        }

        required init?(coder: NSCoder) { fatalError() }

        @objc func onTap(_ g: UITapGestureRecognizer) {
            let p = CoordinateMap.desktopPoint(from: g.location(in: self), in: bounds)
            Task { await seat?.tapDesktop(x: p.x, y: p.y) }
        }

        @objc func onRightTap(_ g: UITapGestureRecognizer) {
            let p = CoordinateMap.desktopPoint(from: g.location(in: self), in: bounds)
            Task {
                await seat?.tapDesktop(x: p.x, y: p.y)
                await seat?.click(button: "right")
            }
        }

        @objc func onHold(_ g: UILongPressGestureRecognizer) {
            guard g.state == .began else { return }
            let p = CoordinateMap.desktopPoint(from: g.location(in: self), in: bounds)
            Task {
                await seat?.tapDesktop(x: p.x, y: p.y)
                await seat?.click(button: "right")
            }
        }

        @objc func onPan(_ g: UIPanGestureRecognizer) {
            let p = CoordinateMap.desktopPoint(from: g.location(in: self), in: bounds)
            if g.state == .changed {
                Task { await seat?.dragTo(x: p.x, y: p.y) }
            } else if g.state == .ended || g.state == .cancelled {
                Task { await seat?.move(dx: 0, dy: 0, grab: false) }
            }
        }

        @objc func onTwoPan(_ g: UIPanGestureRecognizer) {
            if g.state == .changed {
                let t = g.translation(in: self)
                let dx = Int((t.x / 40).rounded())
                let dy = Int((-t.y / 40).rounded())
                if dx != 0 || dy != 0 {
                    g.setTranslation(.zero, in: self)
                    Task { await seat?.scroll(dx: dx, dy: dy) }
                }
            }
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
