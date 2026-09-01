import SwiftUI

struct ComputerView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @StateObject private var seat = SeatController()
    @State private var showClipboard = false
    @State private var showKeyboard = false
    @State private var typed = ""
    @State private var showMenu = false
    @State private var showNewBot = false
    @State private var newBotId = ""
    @State private var newBotResult: String?
    @State private var newBotToken: String?

    var body: some View {
        VStack(spacing: 0) {
            if model.waiting || model.status?.state == .waiting {
                WaitingBanner()
            }
            GeometryReader { geo in
                ZStack {
                    if let url = vncURL {
                        VncView(url: url, reloadToken: model.vncReload) { message in
                            model.reportDesktopFailure(message)
                        }
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
                    // Over the pixels, because the failure this reports is that
                    // there are none — the black underneath explains nothing.
                    VStack {
                        if let failure = model.reach.failure {
                            UnreachableBanner(message: failure.message, retryable: failure.retryable) {
                                Task { await model.retry() }
                            }
                        }
                        Spacer()
                        if let error = seat.error {
                            SeatErrorBanner(message: error) { seat.error = nil }
                        }
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
                syncScreen()
            }
        }
        .onChange(of: model.selectedScreen) {
            syncScreen()
        }
        .sheet(isPresented: $showClipboard) {
            if let client = model.client {
                ClipboardSheet(client: client, display: seat.display)
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
                                Task { await seat.type(t) }
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

    /// Point the seat at the selected Bot's screen (nil selection = primary).
    private func syncScreen() {
        if let screen = model.currentScreen {
            seat.display = screen.display == 1 ? nil : screen.display
            seat.vncURL = URL(string: screen.vncUrl)
        } else if let s = model.status {
            seat.display = nil
            seat.vncURL = URL(string: s.vncUrl)
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
            Menu {
                ForEach(model.screens) { screen in
                    Button {
                        model.selectScreen(screen)
                    } label: {
                        if screen.display == model.currentScreen?.display {
                            Label(screen.botId, systemImage: "checkmark")
                        } else {
                            Text(screen.botId)
                        }
                    }
                }
                Divider()
                Button {
                    showNewBot = true
                } label: {
                    Label("New Bot…", systemImage: "plus")
                }
            } label: {
                Label("Screen", systemImage: "rectangle.on.rectangle")
            }
            .alert("New Bot", isPresented: $showNewBot) {
                TextField("name, e.g. night", text: $newBotId)
                    .textInputAutocapitalization(.never)
                Button("Create") {
                    let id = newBotId.trimmingCharacters(in: .whitespaces)
                    newBotId = ""
                    Task {
                        do {
                            let creds = try await model.createBot(id: id)
                            newBotToken = creds.token
                            newBotResult = "\(creds.id) is live on screen \(creds.display).\n\nToken (shown once):\n\(creds.token)"
                        } catch {
                            newBotToken = nil
                            newBotResult = error.localizedDescription
                        }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Gets its own screen on the shared box.")
            }
            .alert("Bot", isPresented: .init(get: { newBotResult != nil }, set: { if !$0 { newBotResult = nil } })) {
                if newBotToken != nil {
                    Button("Copy token") { UIPasteboard.general.string = newBotToken }
                }
                Button("Done", role: .cancel) {}
            } message: {
                Text(newBotResult ?? "")
            }
            Spacer()
            // While the agent holds the seat every gesture here is refused, so
            // the bar offers the way in rather than looking broken.
            if model.currentScreen?.state == .agent {
                Button {
                    Task { await model.takeSeat() }
                } label: {
                    Text("Take the seat")
                        .fontWeight(.semibold)
                }
                .buttonStyle(.bordered)
            } else {
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
        }
        .padding()
        .background(.ultraThinMaterial)
    }
}

@MainActor
final class SeatController: ObservableObject {
    @Published var trackpad = false
    @Published var error: String?
    @Published var cursor: ComputerV1.Point?
    @Published var vncURL: URL?
    /// Window index of the screen being driven. Nil = primary.
    @Published var display: Int?
    private var client: ComputerClient?

    func attach(_ client: ComputerClient) {
        self.client = client
        cursor = ComputerV1.Point(x: 640, y: 400)
    }

    func move(dx: Int, dy: Int, grab: Bool = false) async {
        guard let client else { return }
        // Move the drawn cursor now and reconcile with the box afterwards.
        // Waiting for the round trip to paint it is what makes a remote
        // desktop feel broken: your finger is here and the pointer is behind.
        if let at = cursor {
            cursor = ComputerV1.Point(
                x: min(max(at.x + dx, 0), ComputerV1.display.width - 1),
                y: min(max(at.y + dy, 0), ComputerV1.display.height - 1)
            )
        }
        await perform { try await client.pointer(.move(dx: dx, dy: dy, grab: grab, display: self.display)) }
    }

    func click(button: String = "left") async {
        guard let client else { return }
        await perform { try await client.pointer(.click(button: button, display: self.display)) }
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
        await perform { try await client.pointer(.scroll(dx: dx, dy: dy, display: self.display)) }
    }

    func type(_ text: String) async {
        guard let client else { return }
        await perform { try await client.type(text, display: self.display) }
    }

    func recenter() async {
        let cur = cursor ?? ComputerV1.Point(x: 640, y: 400)
        await move(dx: 640 - cur.x, dy: 400 - cur.y)
    }

    /// SEAT_HELD and OUT_OF_BOUNDS are the two things the seat says most, and
    /// dropping them leaves a screen that ignores every gesture with no reason
    /// given. Success clears the last one. A pan refused while the agent holds
    /// the seat lands here at gesture rate, so only a change is published.
    private func perform(_ call: () async throws -> ComputerV1.PointerResponse) async {
        do {
            cursor = try await call().cursor
            if error != nil { error = nil }
        } catch {
            let message = error.localizedDescription
            if self.error != message { self.error = message }
        }
    }
}
