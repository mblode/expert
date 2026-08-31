import SwiftUI
import UniformTypeIdentifiers

struct ClipboardSheet: View {
    var client: ComputerClient
    @Environment(\.dismiss) private var dismiss
    @State private var box = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Box clipboard") {
                    TextField("UTF-8 only in v1", text: $box, axis: .vertical)
                        .lineLimit(4...10)
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
                                    _ = try await client.clipboardSet(t)
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
                do { box = try await client.clipboardGet().text }
                catch { self.error = error.localizedDescription }
            }
        }
        .presentationDetents([.medium, .large])
    }
}
