import SwiftUI
import UIKit

/// Trackpad mode: the finger nudges the pointer by relative deltas instead of
/// putting it where you touched. Same UIKit recognizer approach as
/// `DesktopGestures`, only rendered while `seat.trackpad` is on.
struct TrackpadView: UIViewRepresentable {
    var seat: SeatController
    var enabled: Bool

    func makeUIView(context: Context) -> PadView {
        let v = PadView()
        v.seat = seat
        v.isUserInteractionEnabled = enabled
        return v
    }

    func updateUIView(_ uiView: PadView, context: Context) {
        uiView.seat = seat
        uiView.isUserInteractionEnabled = enabled
    }

    final class PadView: UIView, UIGestureRecognizerDelegate {
        var seat: SeatController?
        /// Sub-pixel remainder, so a slow finger still moves the pointer.
        private var carry: CGPoint = .zero
        /// True between "double-tap and hold" and the finger lifting.
        private var dragging = false

        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = .clear
            isMultipleTouchEnabled = true

            let tap = UITapGestureRecognizer(target: self, action: #selector(onTap(_:)))
            tap.numberOfTouchesRequired = 1
            addGestureRecognizer(tap)

            // One tap, then press and hold: the trackpad drag idiom.
            let dragHold = UILongPressGestureRecognizer(target: self, action: #selector(onDragHold(_:)))
            dragHold.numberOfTapsRequired = 1
            dragHold.minimumPressDuration = 0.12
            addGestureRecognizer(dragHold)
            tap.require(toFail: dragHold)

            let pan = UIPanGestureRecognizer(target: self, action: #selector(onPan(_:)))
            pan.minimumNumberOfTouches = 1
            pan.maximumNumberOfTouches = 1
            addGestureRecognizer(pan)

            let two = UIPanGestureRecognizer(target: self, action: #selector(onTwoPan(_:)))
            two.minimumNumberOfTouches = 2
            two.maximumNumberOfTouches = 2
            addGestureRecognizer(two)

            [tap, dragHold, pan, two].forEach { $0.delegate = self }
        }

        required init?(coder: NSCoder) { fatalError() }

        @objc func onTap(_ g: UITapGestureRecognizer) {
            Task { await seat?.click() }
        }

        @objc func onDragHold(_ g: UILongPressGestureRecognizer) {
            switch g.state {
            case .began:
                dragging = true
                carry = .zero
            case .ended, .cancelled, .failed:
                guard dragging else { return }
                dragging = false
                carry = .zero
                Task { await seat?.move(dx: 0, dy: 0, grab: false) }
            default:
                break
            }
        }

        @objc func onPan(_ g: UIPanGestureRecognizer) {
            guard g.state == .changed else { return }
            let (dx, dy) = consume(g.translation(in: self))
            g.setTranslation(.zero, in: self)
            guard dx != 0 || dy != 0 else { return }
            let grab = dragging
            Task { await seat?.move(dx: dx, dy: dy, grab: grab) }
        }

        @objc func onTwoPan(_ g: UIPanGestureRecognizer) {
            guard g.state == .changed else { return }
            let t = g.translation(in: self)
            let dx = Int((t.x / 40).rounded())
            let dy = Int((-t.y / 40).rounded())
            if dx != 0 || dy != 0 {
                g.setTranslation(.zero, in: self)
                Task { await seat?.scroll(dx: dx, dy: dy) }
            }
        }

        /// View-point translation to whole desktop pixels, keeping the remainder.
        private func consume(_ translation: CGPoint) -> (dx: Int, dy: Int) {
            let v = CoordinateMap.desktopVector(from: translation, in: bounds)
            carry.x += v.x
            carry.y += v.y
            let dx = carry.x.rounded(.towardZero)
            let dy = carry.y.rounded(.towardZero)
            carry.x -= dx
            carry.y -= dy
            return (Int(dx), Int(dy))
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            true
        }
    }
}
