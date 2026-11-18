import Foundation

enum ActionError: LocalizedError {
    case serverUnavailable
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .serverUnavailable:
            return "The Boxge server is not running."
        case .failed(let message):
            return message
        }
    }
}

final class StatusSource {
    static let stackLabel = "boxge.stack"
    static let serviceLabel = "boxge.service"

    private let infoURL: URL = {
        if let override = ProcessInfo.processInfo.environment["BOXGE_LOCAL_API_FILE"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".boxge")
            .appendingPathComponent("local-api.json")
    }()

    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    private let workQueue = DispatchQueue(label: "com.boxge.menubar.cli", qos: .utility)

    private lazy var containerBinary: URL? = {
        var candidates: [String] = []
        if let override = ProcessInfo.processInfo.environment["BOXGE_CONTAINER_BIN"] {
            candidates.append(override)
        }
        candidates += ["/usr/local/bin/container", "/opt/homebrew/bin/container"]
        return candidates
            .first { FileManager.default.isExecutableFile(atPath: $0) }
            .map { URL(fileURLWithPath: $0) }
    }()

    func serverInfo() -> ServerInfo? {
        guard let data = try? Data(contentsOf: infoURL) else {
            return nil
        }
        return try? JSONDecoder().decode(ServerInfo.self, from: data)
    }

    func fetch(completion: @escaping (Snapshot) -> Void) {
        guard let info = serverInfo() else {
            fetchFromCLI(completion: completion)
            return
        }
        let request = makeRequest(info, path: "/api/local/status", method: "GET", timeout: 5)
        session.dataTask(with: request) { data, response, _ in
            if let data,
               (response as? HTTPURLResponse)?.statusCode == 200,
               let status = try? JSONDecoder().decode(StatusResponse.self, from: data) {
                completion(Snapshot(
                    source: .server(info.url),
                    boxgeVersion: status.boxge.version,
                    runtime: status.runtime,
                    stacks: status.stacks,
                    runningContainers: status.containers?.running ?? status.stacks.reduce(0) { $0 + $1.running }))
                return
            }
            self.fetchFromCLI(completion: completion)
        }.resume()
    }

    func post(_ path: String, timeout: TimeInterval, completion: @escaping (Result<Void, ActionError>) -> Void) {
        guard let info = serverInfo() else {
            completion(.failure(.serverUnavailable))
            return
        }
        let request = makeRequest(info, path: path, method: "POST", timeout: timeout)
        session.dataTask(with: request) { data, response, error in
            if let error {
                completion(.failure(.failed(error.localizedDescription)))
                return
            }
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (200..<300).contains(code) {
                completion(.success(()))
                return
            }
            let body = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let message = (body?["msg"] as? String) ?? "The server answered \(code)."
            completion(.failure(.failed(message)))
        }.resume()
    }

    func runWithCLI(_ arguments: [String], timeout: TimeInterval, completion: @escaping (Result<Void, ActionError>) -> Void) {
        workQueue.async {
            guard let result = self.runCLI(arguments, timeout: timeout) else {
                completion(.failure(.failed("The container command line tool was not found.")))
                return
            }
            if result.status == 0 {
                completion(.success(()))
            } else {
                completion(.failure(.failed("container \(arguments.joined(separator: " ")) exited with status \(result.status).")))
            }
        }
    }

    private func makeRequest(_ info: ServerInfo, path: String, method: String, timeout: TimeInterval) -> URLRequest {
        let base = info.url.absoluteString.hasSuffix("/") ? String(info.url.absoluteString.dropLast()) : info.url.absoluteString
        var request = URLRequest(url: URL(string: base + path) ?? info.url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("Bearer \(info.token)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func fetchFromCLI(completion: @escaping (Snapshot) -> Void) {
        workQueue.async {
            completion(self.cliSnapshot())
        }
    }

    private func cliSnapshot() -> Snapshot {
        guard containerBinary != nil else {
            return Snapshot(source: .unavailable, boxgeVersion: nil, runtime: nil, stacks: [])
        }

        var version = "unknown"
        if let result = runCLI(["--version"], timeout: 10),
           let text = String(data: result.output, encoding: .utf8),
           let range = text.range(of: #"\d+\.\d+\.\d+"#, options: .regularExpression) {
            version = String(text[range])
        }

        guard let list = runCLI(["list", "--all", "--format", "json"], timeout: 15),
              list.status == 0,
              let containers = try? JSONSerialization.jsonObject(with: list.output) as? [[String: Any]] else {
            let runtime = RuntimeInfo(running: false, version: version, supported: true, minVersion: "")
            return Snapshot(source: .cli, boxgeVersion: nil, runtime: runtime, stacks: [])
        }

        var grouped: [String: [ServiceInfo]] = [:]
        let runningContainers = containers.filter {
            (($0["status"] as? [String: Any])?["state"] as? String) == "running"
        }.count
        for container in containers {
            guard let config = container["configuration"] as? [String: Any],
                  let labels = config["labels"] as? [String: Any],
                  let stack = labels[Self.stackLabel] as? String else {
                continue
            }
            let id = (container["id"] as? String) ?? (config["id"] as? String) ?? "?"
            let fallbackName = id.hasPrefix(stack + "-") ? String(id.dropFirst(stack.count + 1)) : id
            let name = (labels[Self.serviceLabel] as? String) ?? fallbackName
            let state = ((container["status"] as? [String: Any])?["state"] as? String) ?? "unknown"
            grouped[stack, default: []].append(ServiceInfo(name: name, state: state, health: nil))
        }

        let stacks = grouped.keys.sorted().map { name -> StackInfo in
            let services = (grouped[name] ?? []).sorted { $0.name < $1.name }
            let running = services.filter { $0.state == "running" }.count
            let status = running == services.count ? "running" : (running > 0 ? "partial" : "stopped")
            return StackInfo(
                name: name,
                status: status,
                running: running,
                total: services.count,
                managed: false,
                busy: false,
                error: nil,
                services: services)
        }
        let runtime = RuntimeInfo(running: true, version: version, supported: true, minVersion: "")
        return Snapshot(source: .cli, boxgeVersion: nil, runtime: runtime, stacks: stacks, runningContainers: runningContainers)
    }

    private func runCLI(_ arguments: [String], timeout: TimeInterval) -> (status: Int32, output: Data)? {
        guard let binary = containerBinary else {
            return nil
        }
        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        let watchdog = DispatchWorkItem {
            if process.isRunning {
                process.terminate()
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: watchdog)
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        watchdog.cancel()
        return (process.terminationStatus, data)
    }
}
