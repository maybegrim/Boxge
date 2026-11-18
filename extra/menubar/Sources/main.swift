import Cocoa

if CommandLine.arguments.contains("--print-status") {
    let done = DispatchSemaphore(value: 0)
    let source = StatusSource()
    source.fetch { snapshot in
        print(snapshot.describe())
        done.signal()
    }
    _ = done.wait(timeout: .now() + 30)
    exit(0)
}

if CommandLine.arguments.contains("--print-menu") {
    let done = DispatchSemaphore(value: 0)
    let source = StatusSource()
    var fetched: Snapshot?
    source.fetch { snapshot in
        fetched = snapshot
        done.signal()
    }
    _ = done.wait(timeout: .now() + 30)
    NSApplication.shared.setActivationPolicy(.accessory)
    let controller = MenuController()
    if let fetched {
        controller.apply(fetched)
    }
    print(controller.describeMenu())
    exit(0)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let controller = MenuController()

    func applicationDidFinishLaunching(_ notification: Notification) {
        controller.start()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
