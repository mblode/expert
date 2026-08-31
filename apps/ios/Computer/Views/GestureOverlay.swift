import SwiftUI

/// Gesture copy matches Grok’s help card. Maps view points → 1280×800.
struct GestureOverlay: View {
    @ObservedObject var seat: SeatController
    var bounds: CGSize
    @State private var lastDrag: CGPoint?
    @State private var holdWork: DispatchWorkItem?

    var body: some View {
        Color.clear
            .contentShape(Rectangle())
            .gesture(tap)
            .simultaneousGesture(drag)
            .simultaneousGesture(scroll)
            .simultaneousGesture(pinch)
    }

    private var tap: some Gesture {
        SpatialTapGesture()
            .onEnded { value in
                let p = CoordinateMap.desktopPoint(from: value.location, in: CGRect(origin: .zero, size: bounds))
                Task { await seat.tapDesktop(x: p.x, y: p.y) }
            }
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                let p = CoordinateMap.desktopPoint(from: value.location, in: CGRect(origin: .zero, size: bounds))
                Task { await seat.dragTo(x: p.x, y: p.y) }
            }
            .onEnded { _ in
                Task { await seat.move(dx: 0, dy: 0, grab: false) }
            }
    }

    private var scroll: some Gesture {
        MagnifyGesture().onChanged { _ in }
            .exclusively(before:
                DragGesture(minimumDistance: 8)
            )
        // two-finger scroll via scrollImpulse from highPriority below
    }

    private var pinch: some Gesture {
        MagnifyGesture()
            .onChanged { _ in
                // Visual zoom is the WKWebView transform’s job in a later polish pass.
                // Coordinate space stays 1280×800.
            }
    }
}

struct TrackpadView: View {
    @ObservedObject var seat: SeatController
    @State private var last: CGPoint?

    var body: some View {
        Rectangle()
            .fill(Color.white.opacity(0.08))
            .overlay(Text("Trackpad").foregroundStyle(.white.opacity(0.5)))
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        if let last {
                            let dx = Int((v.location.x - last.x).rounded())
                            let dy = Int((v.location.y - last.y).rounded())
                            Task { await seat.move(dx: dx, dy: dy) }
                        }
                        last = v.location
                    }
                    .onEnded { _ in last = nil }
            )
            .onTapGesture(count: 2) {
                Task { await seat.click() }
            }
            .onTapGesture {
                Task { await seat.click() }
            }
            .gesture(
                LongPressGesture(minimumDuration: 0.35)
                    .sequenced(before: DragGesture())
                    .onChanged { value in
                        if case .second(true, let drag?) = value {
                            Task { await seat.move(dx: Int(drag.translation.width / 12), dy: Int(drag.translation.height / 12), grab: true) }
                        }
                    }
                    .onEnded { _ in
                        Task { await seat.move(dx: 0, dy: 0, grab: false) }
                    }
            )
    }
}
