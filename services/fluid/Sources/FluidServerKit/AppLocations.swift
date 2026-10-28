import Foundation

/// The per-application locations a bundle identifier keys, following the same
/// convention as an `.app`: `~/Library/Caches/<id>/`,
/// `~/Library/Application Support/<id>/`, and `<user temp>/<id>/`.
///
/// Only `temporary` is created here — at startup, by `prepareTemporaryDirectory`.
/// `caches` and `applicationSupport` are exposed but never created: CoreML
/// writes the former on its own, and nothing today writes the latter.
public struct AppLocations: Sendable {
    public let identifier: String

    public init(identifier: String) {
        self.identifier = identifier
    }

    public var caches: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            .appendingPathComponent(identifier, isDirectory: true)
    }

    public var applicationSupport: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent(identifier, isDirectory: true)
    }

    public var temporary: URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(identifier, isDirectory: true)
    }

    /// Creates this application's temp subdirectory, empty. Removes whatever a
    /// crashed previous run left there first, so a leftover file is never
    /// mistaken for one this run wrote.
    ///
    /// Thrown errors already name the path, since the failure is meaningless
    /// without it.
    public func prepareTemporaryDirectory() throws {
        let dir = temporary
        let fm = FileManager.default
        do {
            if fm.fileExists(atPath: dir.path) {
                try fm.removeItem(at: dir)
            }
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            throw AppLocationsError.temporaryDirectoryUnavailable(path: dir.path, detail: error)
        }
    }
}

public enum AppLocationsError: Error, CustomStringConvertible {
    case temporaryDirectoryUnavailable(path: String, detail: Error)

    public var description: String {
        switch self {
        case .temporaryDirectoryUnavailable(let path, let detail):
            return "could not prepare the temp directory at \(path): \(detail)"
        }
    }
}
