import Foundation

struct ServiceInfo: Decodable, Equatable {
    let name: String
    let state: String
    let health: String?
}

struct StackInfo: Decodable, Equatable {
    let name: String
    let status: String
    let running: Int
    let total: Int
    let managed: Bool
    let busy: Bool
    let error: String?
    let services: [ServiceInfo]
}

struct RuntimeInfo: Decodable, Equatable {
    let running: Bool
    let version: String
    let supported: Bool
    let minVersion: String
}

struct BoxgeInfo: Decodable, Equatable {
    let version: String
}

struct ContainerCounts: Decodable, Equatable {
    let running: Int
    let total: Int
}

struct StatusResponse: Decodable {
    let boxge: BoxgeInfo
    let runtime: RuntimeInfo
    let containers: ContainerCounts?
    let stacks: [StackInfo]
}

struct ServerInfo: Decodable, Equatable {
    let url: URL
    let token: String
}

enum SnapshotSource: Equatable {
    case server(URL)
    case cli
    case unavailable
}

struct Snapshot: Equatable {
    var source: SnapshotSource
    var boxgeVersion: String?
    var runtime: RuntimeInfo?
    var stacks: [StackInfo]
    var runningContainers: Int = 0

    var serverURL: URL? {
        if case .server(let url) = source {
            return url
        }
        return nil
    }

    var activeStackCount: Int {
        stacks.filter { $0.running > 0 }.count
    }

    func describe() -> String {
        var lines: [String] = []
        switch source {
        case .server(let url):
            lines.append("source: Boxge server at \(url.absoluteString) (version \(boxgeVersion ?? "?"))")
        case .cli:
            lines.append("source: container CLI (Boxge server not reachable)")
        case .unavailable:
            lines.append("source: unavailable (no server and no container CLI)")
        }
        if let runtime {
            lines.append("runtime: \(runtime.version) \(runtime.running ? "running" : "stopped")\(runtime.supported ? "" : " (needs \(runtime.minVersion)+)")")
        } else {
            lines.append("runtime: unknown")
        }
        lines.append("running containers: \(runningContainers)")
        if stacks.isEmpty {
            lines.append("stacks: none")
        }
        for stack in stacks {
            lines.append("stack \(stack.name): \(stack.status) \(stack.running)/\(stack.total)\(stack.busy ? " busy" : "")\(stack.error.map { " error=\($0)" } ?? "")")
            for service in stack.services {
                lines.append("  \(service.name): \(service.state)\(service.health.map { " (\($0))" } ?? "")")
            }
        }
        return lines.joined(separator: "\n")
    }
}
