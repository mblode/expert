import SwiftUI

struct ComputerView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var seat = SeatController()
    @State private var showClipboard = false
    @State private var showKeyboard = false
    @State private var typed = ""
    @State private var showMenu = false

    var body: some View {
        VStack(spacing: 0) {
            if model.waiting || model.status?.state == .waiting {
                WaitingBanner()
            }
            GeometryReader { geo in
                ZStack {
                    if let url = vncURL {
                        VncView(url: url)
                            .allowsHitTesting(false)
                    } else {
                        Color.black
                    }
                    DesktopGestures(seat: seat, enabled: !seat.trackpad)
                        .opacity(seat.trackpad ? 0 : 1)
                    if seat.trackpad {
                        TrackpadView(seat: seat)
                    }
                    if let c = seat.cursor {
                        Circle()
                            .fill(Color.white.opacity(0.85))
                            .frame(width: 10, height: 10)
                            .position(CoordinateMap.viewPoint(from: (c.x, c.y), in: CGRect(origin: .zero, size: geo.size)))
                            .allowsHitTesting(false)
                    }
                }
            }
            bottomBar
        }
        .background(Color.black)
        .task {
            await model.refreshStatus()
            if let client = model.client {
                seat.attach(client)
                if let s = model.status {
                    seat.vncURL = URL(string: s.vncUrl)
                }
            }
        }
        .sheet(isPresented: $showClipboard) {
            if let client = model.client {
                ClipboardSheet(client: client)
            }
        }
        .sheet(isPresented: $showKeyboard) {
            NavigationStack {
                TextField("Type into the focused field", text: $typed, axis: .vertical)
                    .padding()
                    .navigationTitle("Keyboard")
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Send") {
                                let t = typed
                                typed = ""
                                showKeyboard = false
                                Task { try? await seat.type(t) }
                            }
                        }
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Close") { showKeyboard = false }
                        }
                    }
            }
            .presentationDetents([.medium])
        }
    }

    private var vncURL: URL? {
        seat.vncURL ?? model.status.flatMap { URL(string: $0.vncUrl) }
    }

    private var bottomBar: some View {
        HStack(spacing: 16) {
            Button { showKeyboard = true } label: {
                Label("Keyboard", systemImage: "keyboard")
            }
            Button { showClipboard = true } label: {
                Label("Clipboard", systemImage: "doc.on.clipboard")
            }
            Menu {
                Button(seat.trackpad ? "Exit trackpad" : "Trackpad mode") {
                    seat.trackpad.toggle()
                }
                Button("Recenter pointer") { Task { await seat.recenter() } }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            Spacer()
            Button {
                Task {
                    await model.imDone()
                    dismiss()
                }
            } label: {
                Text("I’m done")
                    .fontWeight(.semibold)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding()
        .background(.ultraThinMaterial)
    }
}

@MainActor
final class SeatController: ObservableObject {
    @Published var trackpad = false
    @Published var cursor: ComputerV1.Point?
    @Published var vncURL: URL?
    private var client: ComputerClient?

    func attach(_ client: ComputerClient) {
        self.client = client
        cursor = ComputerV1.Point(x: 640, y: 400)
    }

    func move(dx: Int, dy: Int, grab: Bool = false) async {
        guard let client else { return }
        do {
            let r = try await client.pointer(.move(dx: dx, dy: dy, grab: grab))
            cursor = r.cursor
        } catch { }
    }

    func click(button: String = "left") async {
        guard let client else { return }
        do {
            let r = try await client.pointer(.click(button: button))
            cursor = r.cursor
        } catch { }
    }

    func tapDesktop(x: Int, y: Int) async {
        let cur = cursor ?? ComputerV1.Point(x: 640, y: 400)
        await move(dx: x - cur.x, dy: y - cur.y)
        await click()
    }

    func dragTo(x: Int, y: Int) async {
        let cur = cursor ?? ComputerV1.Point(x: 640, y: 400)
        await move(dx: x - cur.x, dy: y - cur.y, grab: true)
    }

    func scroll(dx: Int, dy: Int) async {
        guard let client else { return }
        struct Scroll: Encodable { var type = "scroll"; var dx: Int; var dy: Int }
        var req = URLRequest(url: client.url(ComputerV1.seatPaths.pointer))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = client.token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try? JSONEncoder().encode(Scroll(dx: dx, dy: dy))
        _ = try? await URLSession.shared.data(for: req)
    }

    func type(_ text: String) async throws {
        guard let client else { return }
        let r = try await client.type(text)
        cursor = r.cursor
    }

    func recenter() async {
        let cur = cursor ?? ComputerV1.Point(x: 640, y: 400)
        await move(dx: 640 - cur.x, dy: 400 - cur.y)
    }
}
