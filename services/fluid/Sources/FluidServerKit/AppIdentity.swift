import Foundation

/// The identity a server's `.app` bundle declares.
///
/// `Bundle.main.infoDictionary` resolves `Contents/Info.plist` when the
/// running executable sits inside a bundle at `Contents/MacOS/`. Launched any
/// other way — a bare `swift run`, or a test host — there is no bundle to
/// read, and `resolve(info:executableName:)` falls back to the executable's
/// own name as the identifier and "unknown" for both versions, rather than
/// crashing a process that is not actually misconfigured, only unpackaged.
public struct AppIdentity: Sendable {
    public let bundleIdentifier: String
    public let shortVersion: String
    public let buildVersion: String

    public init(bundleIdentifier: String, shortVersion: String, buildVersion: String) {
        self.bundleIdentifier = bundleIdentifier
        self.shortVersion = shortVersion
        self.buildVersion = buildVersion
    }

    /// Reads the three fields from an info dictionary, or nil if any is
    /// missing. Takes the dictionary rather than a `Bundle` so the missing
    /// case is reachable directly, without depending on some real bundle
    /// actually lacking these keys.
    public init?(info: [String: Any]?) {
        guard let info,
            let id = info["CFBundleIdentifier"] as? String,
            let shortVersion = info["CFBundleShortVersionString"] as? String,
            let buildVersion = info["CFBundleVersion"] as? String
        else { return nil }
        self.init(bundleIdentifier: id, shortVersion: shortVersion, buildVersion: buildVersion)
    }

    public init?(bundle: Bundle) {
        self.init(info: bundle.infoDictionary)
    }

    /// `info` if it resolves, else the executable-name fallback. Takes the
    /// dictionary rather than defaulting to `Bundle.main.infoDictionary`
    /// directly, so a test can supply the missing case without depending on
    /// what the test host's own bundle happens to carry.
    public static func resolve(info: [String: Any]?, executableName: String) -> AppIdentity {
        AppIdentity(info: info)
            ?? AppIdentity(
                bundleIdentifier: executableName, shortVersion: "unknown", buildVersion: "unknown")
    }
}
