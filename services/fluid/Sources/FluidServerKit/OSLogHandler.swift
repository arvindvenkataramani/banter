import Foundation
import Logging
import os.log

/// Mirrors swift-log output into unified logging, keyed by the server's bundle
/// identifier as the subsystem. `log stream --predicate 'subsystem == "<id>"'`
/// and Console.app then show a server's log alongside the rest of the system,
/// beside the stdout stream the shard runner already captures.
public struct OSLogHandler: LogHandler {
    private let log: OSLog
    private let label: String
    public var metadata: Logging.Logger.Metadata = [:]
    public var logLevel: Logging.Logger.Level = .info

    public init(subsystem: String, label: String) {
        self.log = OSLog(subsystem: subsystem, category: label)
        self.label = label
    }

    public subscript(metadataKey key: String) -> Logging.Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }

    public func log(
        level: Logging.Logger.Level, message: Logging.Logger.Message,
        metadata: Logging.Logger.Metadata?,
        source: String, file: String, function: String, line: UInt
    ) {
        // "%{public}s": os_log redacts %s as <private> by default, which would
        // hide every message in Console.app and `log stream` alike.
        os_log("%{public}s", log: log, type: level.osLogType, "\(message)")
    }
}

extension Logging.Logger.Level {
    fileprivate var osLogType: OSLogType {
        switch self {
        case .trace, .debug: return .debug
        case .info, .notice: return .info
        case .warning: return .default
        case .error: return .error
        case .critical: return .fault
        }
    }
}
