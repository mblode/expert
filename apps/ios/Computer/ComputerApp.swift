import SwiftUI

@main
struct ComputerApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        Group {
            if model.session == nil {
                SignInView()
            } else {
                ChatView()
            }
        }
        .task { model.restore() }
    }
}
