import SwiftUI
import UniformTypeIdentifiers

struct ClipboardSheet: View {
    var client: ComputerClient
    var display: Int?
    @Environment(\.dismiss) private var dismiss
    @State private var box = ""
    @State private var error: String?
    @State private var loading = true

    var body: some View {
        NavigationStack {
            Form {
                Section("Box clipboard") {
                    // An empty field is the box's clipboard being empty, so the
                    // read has to be visible or the two read the same.
                    if loading {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Reading the box clipboard")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        TextField("UTF-8 only in v1", text: $box, axis: .vertical)
                            .lineLimit(4...10)
                        if box.isEmpty {
                            Text("Empty")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
                Section {
                    Button("Copy to iPhone") {
                        UIPasteboard.general.string = box
                    }
                    Button("Paste from iPhone") {
                        Task {
                            if let t = UIPasteboard.general.string {
                                do {
                                    _ = try await client.clipboardSet(t, display: display)
                                    box = t
                                } catch { self.error = error.localizedDescription }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Clipboard")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .task {
                defer { loading = false }
                do { box = try await client.clipboardGet(display: display).text }
                catch { self.error = error.localizedDescription }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
