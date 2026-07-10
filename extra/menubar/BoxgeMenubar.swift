import Cocoa

final class BoxgeMenuBar: NSObject, NSApplicationDelegate {
    let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    var timer: Timer?

    let containerBin = "/usr/local/bin/container"
    let stackLabel = "boxge.stack"
    let boxgeURL = "http://localhost:5001"

    struct StackInfo {
        var name: String
        var running: Int
        var total: Int
    }

    struct Snapshot {
        var ok: Bool
        var stacks: [StackInfo]
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "square.stack.3d.up.fill", accessibilityDescription: "Boxge")
            button.image?.isTemplate = true
            button.imagePosition = .imageLeading
            button.title = " …"
        }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 8.0, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    func fetchStacks() -> Snapshot {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: containerBin)
        task.arguments = ["list", "--all", "--format", "json"]
        let outPipe = Pipe()
        task.standardOutput = outPipe
        task.standardError = Pipe()

        do {
            try task.run()
        } catch {
            return Snapshot(ok: false, stacks: [])
        }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()

        guard task.terminationStatus == 0,
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return Snapshot(ok: false, stacks: [])
        }

        var map: [String: (running: Int, total: Int)] = [:]
        for c in arr {
            guard let config = c["configuration"] as? [String: Any],
                  let labels = config["labels"] as? [String: Any],
                  let stack = labels[stackLabel] as? String else {
                continue
            }
            let state = ((c["status"] as? [String: Any])?["state"] as? String) ?? "unknown"
            var entry = map[stack] ?? (running: 0, total: 0)
            entry.total += 1
            if state == "running" {
                entry.running += 1
            }
            map[stack] = entry
        }

        let stacks = map
            .map { StackInfo(name: $0.key, running: $0.value.running, total: $0.value.total) }
            .sorted { $0.name < $1.name }
        return Snapshot(ok: true, stacks: stacks)
    }

    @objc func refresh() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self = self else {
                return
            }
            let snapshot = self.fetchStacks()
            DispatchQueue.main.async {
                self.render(snapshot)
            }
        }
    }

    func render(_ snapshot: Snapshot) {
        let activeCount = snapshot.stacks.filter { $0.running > 0 }.count

        if let button = statusItem.button {
            button.title = snapshot.ok ? " \(activeCount)" : " ?"
        }

        let menu = NSMenu()

        let header = NSMenuItem(
            title: snapshot.ok
                ? "Boxge — \(activeCount) active · \(snapshot.stacks.count) stacks"
                : "Boxge — container runtime unreachable",
            action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        if snapshot.stacks.isEmpty {
            let empty = NSMenuItem(
                title: snapshot.ok ? "No stacks deployed" : "Is the container runtime running?",
                action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for s in snapshot.stacks {
                let dot = s.running > 0 ? "🟢" : "⚪️"
                let item = NSMenuItem(title: "\(dot)  \(s.name)   (\(s.running)/\(s.total))", action: nil, keyEquivalent: "")
                item.isEnabled = false
                menu.addItem(item)
            }
        }

        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Boxge", action: #selector(openBoxge), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Refresh", action: #selector(refresh), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Boxge Menu Bar", action: #selector(quit), keyEquivalent: "q"))

        for item in menu.items where item.action != nil {
            item.target = self
        }
        statusItem.menu = menu
    }

    @objc func openBoxge() {
        if let url = URL(string: boxgeURL) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func quit() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = BoxgeMenuBar()
app.delegate = delegate
app.run()
