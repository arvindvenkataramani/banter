import Foundation

/// A value in a provision's `restricts` or `defaults`.
public enum ProvisionValue: Decodable, Sendable, Equatable, CustomStringConvertible {
    case number(Double)
    case bool(Bool)
    case string(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else {
            self = .string(try c.decode(String.self))
        }
    }

    public var description: String {
        switch self {
        case .number(let n): return n.rounded() == n ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        case .string(let s): return s
        }
    }

    /// The value as a whole number, for a parameter that takes one.
    public var int: Int? {
        if case .number(let n) = self, n.rounded() == n { return Int(n) }
        return nil
    }
}

/// One entry of a service's `provides`: an API it serves and how it departs from that API's spec.
public struct Provision: Decodable, Sendable {
    public let api: String
    public let basePath: String?
    public let omits: [String]?
    public let only: [String]?
    public let restricts: [String: [ProvisionValue]]?
    public let defaults: [String: ProvisionValue]?
    public let extends: [String]?

    /// Whether the provision declares `part` absent: omitted, left out by an `only` naming
    /// parts of its kind, or restricted away.
    public func declaresAbsent(_ part: String) -> Bool {
        if omits?.contains(part) == true { return true }
        if let only, let kind = Self.kind(of: part),
            only.contains(where: { Self.kind(of: $0) == kind }), !only.contains(part)
        {
            return true
        }
        if let split = Self.value(part) {
            if declaresAbsent("parameter:\(split.parameter)") { return true }
            if let allowed = restricts?[split.parameter] {
                return !allowed.contains { $0.description == split.value }
            }
        } else if part.hasPrefix("parameter:"), let allowed = restricts?[String(part.dropFirst(10))] {
            return allowed.isEmpty
        }
        return false
    }

    private static func kind(of part: String) -> Substring? {
        part.firstIndex(of: ":").map { part[..<$0] }
    }

    /// `value:<parameter>=<value>` split into its parameter and value.
    private static func value(_ part: String) -> (parameter: String, value: String)? {
        guard part.hasPrefix("value:") else { return nil }
        let body = part.dropFirst(6)
        guard let eq = body.firstIndex(of: "=") else { return nil }
        return (String(body[..<eq]), String(body[body.index(after: eq)...]))
    }
}

public enum ProvisionError: Error, CustomStringConvertible {
    case unreadable(path: String, detail: String)
    case malformed(String)
    case noService(id: String, path: String)
    case unservedApi(service: String, api: String)
    case lackedParts(service: String, api: String, parts: [String])
    case unimplementedExtensions(service: String, api: String, extensions: [String])

    public var description: String {
        switch self {
        case .unreadable(let path, let detail):
            return "cannot read the registry at \(path): \(detail)"
        case .malformed(let detail):
            return "the registry's services are malformed: \(detail)"
        case .noService(let id, let path):
            return "the registry at \(path) has no service \(id)"
        case .unservedApi(let service, let api):
            return "\(service) provides \(api), which this build does not serve"
        case .lackedParts(let service, let api, let parts):
            return
                "\(service) provides \(api) with \(parts.joined(separator: ", ")), which this build lacks; list them in omits"
        case .unimplementedExtensions(let service, let api, let extensions):
            return
                "\(service) provides \(api) extended by \(extensions.joined(separator: ", ")), which this build does not implement"
        }
    }
}

/// Reads a service's own `provides` from the node's registry and checks it against what a build serves.
public enum ProvisionCheck {
    /// The `provides` of service `id` in the registry at `file`; empty when the entry states none.
    public static func read(registry file: URL, service id: String) throws -> [Provision] {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch {
            throw ProvisionError.unreadable(path: file.path, detail: error.localizedDescription)
        }
        let registry: Registry
        do {
            registry = try JSONDecoder().decode(Registry.self, from: data)
        } catch {
            throw ProvisionError.malformed(String(describing: error))
        }
        guard let entry = registry.services.first(where: { $0.id == id }) else {
            throw ProvisionError.noService(id: id, path: file.path)
        }
        return entry.provides ?? []
    }

    /// Refuses a provision of an API the build does not serve, one that does not declare absent a
    /// part the build lacks, or one claiming an extension the build does not implement for that API.
    public static func check(
        _ provisions: [Provision], service: String, build: [String: [String]],
        extensions: [String: [String]]
    ) throws {
        for provision in provisions {
            guard let lacked = build[provision.api] else {
                throw ProvisionError.unservedApi(service: service, api: provision.api)
            }
            let claimed = lacked.filter { !provision.declaresAbsent($0) }
            if !claimed.isEmpty {
                throw ProvisionError.lackedParts(
                    service: service, api: provision.api, parts: claimed)
            }
            let implemented = extensions[provision.api] ?? []
            let unimplemented = (provision.extends ?? []).filter { !implemented.contains($0) }
            if !unimplemented.isEmpty {
                throw ProvisionError.unimplementedExtensions(
                    service: service, api: provision.api, extensions: unimplemented)
            }
        }
    }

    private struct Registry: Decodable {
        let services: [Service]
    }

    private struct Service: Decodable {
        let id: String
        let provides: [Provision]?
    }
}

extension Array where Element == Provision {
    /// The default the provision of `api` declares for `parameter`, if any.
    public func declaredDefault(_ parameter: String, of api: String) -> ProvisionValue? {
        first { $0.api == api }?.defaults?[parameter]
    }
}
