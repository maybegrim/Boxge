import Cocoa
import ServiceManagement

private final class StackCommand: NSObject {
    let stack: String
    let action: String

    init(stack: String, action: String) {
        self.stack = stack
        self.action = action
    }
}

final class MenuController: NSObject, NSMenuDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let source = StatusSource()
    private var snapshot: Snapshot?
    private var refreshing = false
    private var runtimeActivity: String?
    private var timer: Timer?

    private let pollInterval: TimeInterval = 5
    private let serverLabel = "com.boxge.server"

    func start() {
        menu.delegate = self
        menu.autoenablesItems = false
        statusItem.menu = menu
        updateButton()
        rebuildMenu()
        refresh()

        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func menuWillOpen(_ menu: NSMenu) {
        refresh()
    }

    @objc private func refresh() {
        guard !refreshing else {
            return
        }
        refreshing = true
        source.fetch { [weak self] snapshot in
            DispatchQueue.main.async {
                guard let self else {
                    return
                }
                self.refreshing = false
                if self.snapshot != snapshot {
                    self.apply(snapshot)
                }
            }
        }
    }

    func apply(_ snapshot: Snapshot) {
        self.snapshot = snapshot
        updateButton()
        rebuildMenu()
    }

    func describeMenu() -> String {
        var lines = ["[status item] title=\"\(statusItem.button?.title ?? "")\" tooltip=\"\(statusItem.button?.toolTip ?? "")\""]
        func walk(_ menu: NSMenu, depth: Int) {
            for item in menu.items {
                let indent = String(repeating: "    ", count: depth)
                if item.isSeparatorItem {
                    lines.append("\(indent)--------")
                    continue
                }
                var line = "\(indent)\(item.isEnabled ? "•" : "·") \(item.title)"
                if let subtitle = item.subtitle, !subtitle.isEmpty {
                    line += "  (\(subtitle))"
                }
                if !item.keyEquivalent.isEmpty {
                    line += "  ⌘\(item.keyEquivalent.uppercased())"
                }
                if item.state == .on {
                    line += "  ✓"
                }
                lines.append(line)
                if let submenu = item.submenu {
                    walk(submenu, depth: depth + 1)
                }
            }
        }
        walk(menu, depth: 0)
        return lines.joined(separator: "\n")
    }

    private func refreshSoon() {
        for delay in [0.4, 1.5, 4.0] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.refresh()
            }
        }
    }

    private var needsAttention: Bool {
        guard let snapshot else {
            return false
        }
        if snapshot.source == .unavailable {
            return true
        }
        guard let runtime = snapshot.runtime else {
            return true
        }
        return !runtime.running || !runtime.supported
    }

    private func updateButton() {
        guard let button = statusItem.button else {
            return
        }
        let symbol = needsAttention ? "exclamationmark.triangle.fill" : "shippingbox.fill"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Boxge")
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageLeading

        guard let snapshot else {
            button.title = ""
            button.toolTip = "Boxge"
            return
        }
        let active = snapshot.activeStackCount
        button.title = active > 0 ? " \(active)" : ""
        button.toolTip = "Boxge: \(active) of \(snapshot.stacks.count) stacks running"
    }

    private func rebuildMenu() {
        menu.removeAllItems()

        guard let snapshot else {
            menu.addItem(infoItem("Loading…"))
            addFooter(serverURL: nil)
            return
        }

        addHeader(snapshot)
        menu.addItem(.separator())
        addStacks(snapshot)
        menu.addItem(.separator())
        if snapshot.runtime?.running == true {
            let stopAll = actionItem("Stop All Containers", #selector(stopAllContainers))
            stopAll.isEnabled = snapshot.runningContainers > 0 && runtimeActivity == nil
            menu.addItem(stopAll)
            let stopRuntime = actionItem("Stop Apple Container", #selector(stopRuntime))
            stopRuntime.isEnabled = runtimeActivity == nil
            menu.addItem(stopRuntime)
            menu.addItem(.separator())
        }
        addFooter(serverURL: snapshot.serverURL)
    }

    private func addHeader(_ snapshot: Snapshot) {
        switch snapshot.source {
        case .server:
            menu.addItem(infoItem("Boxge \(snapshot.boxgeVersion ?? "")"))
        case .cli:
            menu.addItem(infoItem("Boxge server is not running"))
            if serverPlistURL != nil {
                menu.addItem(actionItem("Start Boxge Server", #selector(startServer)))
            }
        case .unavailable:
            menu.addItem(infoItem("Boxge server is not running"))
            menu.addItem(infoItem("The container command line tool was not found"))
            return
        }

        guard let runtime = snapshot.runtime else {
            return
        }
        if let runtimeActivity {
            menu.addItem(infoItem(runtimeActivity))
        } else if runtime.running {
            menu.addItem(infoItem("Apple Container \(runtime.version) is running"))
        } else {
            menu.addItem(infoItem("Apple Container \(runtime.version) is stopped"))
            menu.addItem(actionItem("Start Apple Container", #selector(startRuntime)))
        }
        if !runtime.supported {
            menu.addItem(infoItem("Boxge needs container \(runtime.minVersion) or later"))
        }
    }

    private func addStacks(_ snapshot: Snapshot) {
        if snapshot.stacks.isEmpty {
            let runtimeRunning = snapshot.runtime?.running ?? false
            menu.addItem(infoItem(runtimeRunning ? "No stacks yet" : "Start Apple Container to see running stacks"))
            return
        }
        let runtimeRunning = snapshot.runtime?.running ?? false
        for stack in snapshot.stacks {
            menu.addItem(stackItem(stack, serverURL: snapshot.serverURL, runtimeRunning: runtimeRunning))
        }
    }

    private func stackItem(_ stack: StackInfo, serverURL: URL?, runtimeRunning: Bool) -> NSMenuItem {
        let item = NSMenuItem(title: stack.name, action: nil, keyEquivalent: "")
        item.image = dot(for: stack)
        item.subtitle = runtimeRunning || stack.busy ? subtitle(for: stack) : "Apple Container is stopped"

        let submenu = NSMenu()
        submenu.autoenablesItems = false
        let canControl = serverURL != nil && stack.managed && !stack.busy

        if serverURL != nil {
            let open = actionItem("Open in Boxge", #selector(openStack(_:)))
            open.representedObject = stack.name
            open.isEnabled = stack.managed
            submenu.addItem(open)
            submenu.addItem(.separator())
        }

        for (title, action, enabled) in [
            ("Start", "start", stack.running < stack.total || stack.total == 0),
            ("Stop", "stop", stack.running > 0),
            ("Restart", "restart", stack.total > 0),
        ] {
            let entry = actionItem(title, #selector(runStackCommand(_:)))
            entry.representedObject = StackCommand(stack: stack.name, action: action)
            entry.isEnabled = canControl && enabled
            submenu.addItem(entry)
        }

        if serverURL == nil {
            submenu.addItem(.separator())
            submenu.addItem(infoItem("Start the Boxge server to control stacks"))
        } else if !stack.managed {
            submenu.addItem(.separator())
            submenu.addItem(infoItem("No compose file for this stack"))
        }

        if let error = stack.error {
            submenu.addItem(.separator())
            submenu.addItem(infoItem("Last error: \(String(error.prefix(120)))"))
        }

        if !stack.services.isEmpty {
            submenu.addItem(.separator())
            for service in stack.services {
                let line = infoItem(service.name)
                line.subtitle = service.health.map { "\(service.state), \($0)" } ?? service.state
                line.image = dot(color: color(forService: service))
                submenu.addItem(line)
            }
        }

        item.submenu = submenu
        return item
    }

    private func subtitle(for stack: StackInfo) -> String {
        if stack.busy {
            return "Working…"
        }
        switch stack.status {
        case "running":
            return stack.total == 1 ? "Running" : "Running, \(stack.total) services"
        case "partial":
            return "\(stack.running) of \(stack.total) services running"
        case "stopped":
            return "Stopped"
        default:
            return "Not deployed"
        }
    }

    private func dot(for stack: StackInfo) -> NSImage? {
        if stack.busy {
            return dot(color: .systemBlue)
        }
        if stack.error != nil && stack.status != "running" {
            return dot(color: .systemRed)
        }
        switch stack.status {
        case "running":
            return dot(color: .systemGreen)
        case "partial":
            return dot(color: .systemOrange)
        case "stopped":
            return dot(color: .systemGray)
        default:
            return dot(color: .systemGray, filled: false)
        }
    }

    private func color(forService service: ServiceInfo) -> NSColor {
        if service.state != "running" {
            return .systemGray
        }
        switch service.health {
        case "unhealthy":
            return .systemRed
        case "starting":
            return .systemOrange
        default:
            return .systemGreen
        }
    }

    private func dot(color: NSColor, filled: Bool = true) -> NSImage? {
        let config = NSImage.SymbolConfiguration(pointSize: 9, weight: .regular)
            .applying(NSImage.SymbolConfiguration(paletteColors: [color]))
        return NSImage(systemSymbolName: filled ? "circle.fill" : "circle", accessibilityDescription: nil)?
            .withSymbolConfiguration(config)
    }

    private func addFooter(serverURL: URL?) {
        let open = actionItem("Open Boxge", #selector(openBoxge), key: "o")
        open.isEnabled = serverURL != nil
        menu.addItem(open)
        menu.addItem(actionItem("Refresh", #selector(refresh), key: "r"))
        menu.addItem(.separator())

        if Bundle.main.bundleIdentifier != nil {
            let login = actionItem("Launch at Login", #selector(toggleLaunchAtLogin))
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
            menu.addItem(login)
        }
        menu.addItem(actionItem("Quit Boxge Menu Bar", #selector(quit), key: "q"))
    }

    private func infoItem(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    private func actionItem(_ title: String, _ action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = true
        return item
    }

    private func browserURL(_ serverURL: URL, path: String = "") -> URL? {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        if components.host == "127.0.0.1" {
            components.host = "localhost"
        }
        components.path = path
        return components.url
    }

    @objc private func openBoxge() {
        if let serverURL = snapshot?.serverURL, let url = browserURL(serverURL) {
            NSWorkspace.shared.open(url)
        }
    }

    @objc private func openStack(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String,
              let serverURL = snapshot?.serverURL,
              let url = browserURL(serverURL, path: "/compose/\(name)") else {
            return
        }
        NSWorkspace.shared.open(url)
    }

    @objc private func runStackCommand(_ sender: NSMenuItem) {
        guard let command = sender.representedObject as? StackCommand else {
            return
        }
        source.post("/api/local/stacks/\(command.stack)/\(command.action)", timeout: 15) { [weak self] result in
            DispatchQueue.main.async {
                if case .failure(let error) = result {
                    self?.showError("Could not \(command.action) \(command.stack)", error.localizedDescription)
                }
                self?.refreshSoon()
            }
        }
        refreshSoon()
    }

    private func runRuntimeAction(activity: String, failure: String, path: String, cli: [String]) {
        guard runtimeActivity == nil else {
            return
        }
        runtimeActivity = activity
        rebuildMenu()
        let finish: (Result<Void, ActionError>) -> Void = { [weak self] result in
            DispatchQueue.main.async {
                guard let self else {
                    return
                }
                self.runtimeActivity = nil
                if case .failure(let error) = result {
                    self.showError(failure, error.localizedDescription)
                }
                self.rebuildMenu()
                self.refreshSoon()
            }
        }
        if snapshot?.serverURL != nil {
            source.post(path, timeout: 300, completion: finish)
        } else {
            source.runWithCLI(cli, timeout: 300, completion: finish)
        }
    }

    @objc private func startRuntime() {
        runRuntimeAction(
            activity: "Starting Apple Container…",
            failure: "Could not start Apple Container",
            path: "/api/local/runtime/start",
            cli: ["system", "start", "--enable-kernel-install"])
    }

    @objc private func stopRuntime() {
        let running = snapshot?.runningContainers ?? 0
        let detail = running > 0
            ? "This stops the container service and the \(running) running container\(running == 1 ? "" : "s"). Services with a restart policy come back when you start it again."
            : "This stops the container service. Nothing is running right now."
        guard confirm("Stop Apple Container?", detail, button: "Stop") else {
            return
        }
        runRuntimeAction(
            activity: "Stopping Apple Container…",
            failure: "Could not stop Apple Container",
            path: "/api/local/runtime/stop",
            cli: ["system", "stop"])
    }

    @objc private func stopAllContainers() {
        let running = snapshot?.runningContainers ?? 0
        guard confirm(
            "Stop all containers?",
            "This stops the \(running) running container\(running == 1 ? "" : "s"), including any that Boxge did not create. They stay stopped until you start them again.",
            button: "Stop All") else {
            return
        }
        runRuntimeAction(
            activity: "Stopping all containers…",
            failure: "Could not stop all containers",
            path: "/api/local/containers/stop-all",
            cli: ["stop", "--all"])
    }

    private func confirm(_ title: String, _ detail: String, button: String) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        alert.addButton(withTitle: button)
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    private var serverPlistURL: URL? {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/\(serverLabel).plist")
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    @objc private func startServer() {
        guard let plist = serverPlistURL else {
            return
        }
        let domain = "gui/\(getuid())"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            for arguments in [["bootstrap", domain, plist.path], ["kickstart", "\(domain)/\(self?.serverLabel ?? "")"]] {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                process.arguments = arguments
                process.standardOutput = FileHandle.nullDevice
                process.standardError = FileHandle.nullDevice
                try? process.run()
                process.waitUntilExit()
            }
            DispatchQueue.main.async {
                self?.refreshSoon()
            }
        }
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
        } catch {
            showError("Could not change Launch at Login", error.localizedDescription)
        }
        rebuildMenu()
    }

    private func showError(_ title: String, _ detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = detail
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}
