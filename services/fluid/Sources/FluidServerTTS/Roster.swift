import FluidAudio
import Foundation

/// What this server was told to offer.
///
/// The same rule as the transcription server: the roster is handed in, the
/// server validates it can serve what it names, and it never enumerates. A
/// compiled list advertises whatever the code could build regardless of what
/// was fetched, which is how nine ids came to be offered for four sets of
/// weights.
///
/// Contract: `schemas/platform.schema.json#/$defs/ttsModel`. Design record:
/// `docs/design/model-roster.md`.

/// One model as the roster declares it.
struct TtsRosterEntry: Sendable, Codable {
    /// The platform's identity for this model — what a selection names.
    let id: String
    let name: String
    /// The identifier this runtime reaches the model by. `pocket-tts` here and
    /// `mlx-community/pocket-tts` under mlx-audio are one model addressed by
    /// two runtimes; what files a key resolves to is the runtime's business.
    let key: String
    /// What cloning demands of a recording, where the model can clone at all.
    /// Absent means it cannot, and a voice asking to clone under it is refused.
    let cloning: TtsCloning?
    /// The model's own chunker constraint. Carried so a caller can respect it
    /// rather than discover it as degraded audio.
    let chunkProfile: TtsChunkProfile?
    /// Voices this model knows by name, needing no reference recording.
    let presetVoices: [TtsPresetVoice]?
}

struct TtsChunkProfile: Sendable, Codable {
    let words: Int
    let chars: Int
}

struct TtsPresetVoice: Sendable, Codable {
    let id: String
    let name: String
}

/// What a model demands of a cloning reference. Whether a given recording
/// satisfies it is arithmetic the shard does at load — this server only states
/// the requirement and enforces that a request carries what it asked for.
struct TtsCloning: Sendable, Codable {
    let available: Bool
    let requiresText: Bool?
    let minDurationS: Double?
    let maxDurationS: Double?
    let sampleRate: Int?
}

/// A roster entry the server has checked it can build a driver for.
struct ValidatedTtsModel: Sendable {
    let entry: TtsRosterEntry

    var id: String { entry.id }
    var name: String { entry.name }
    var key: String { entry.key }
    var cloning: TtsCloning? { entry.cloning }
    var chunkProfile: TtsChunkProfile? { entry.chunkProfile }
    var presetVoices: [TtsPresetVoice] { entry.presetVoices ?? [] }

    /// Every synthesis model serves both routes: the file consumer posts and
    /// the voice loop upgrades to the socket, on one port. Reported as a set
    /// rather than assumed, because the client should read it rather than
    /// know it.
    var transports: [String] { ["http", "websocket"] }

    /// Synthesis is not batch-or-streaming the way transcription is — the same
    /// driver serves a one-shot request and a stream. Every model is `both`.
    var kind: String { "both" }

    var canClone: Bool { entry.cloning?.available ?? false }
    var requiresRefText: Bool { entry.cloning?.requiresText ?? false }

    /// Whether this model's weights are in the cache root its own runtime
    /// reads. TTS uses `~/.cache/fluidaudio/`, which is not where the ASR
    /// models live — asking the runtime rather than assuming one root is what
    /// keeps this honest.
    var present: Bool {
        guard let folder = Self.folder(for: entry.key) else { return false }
        return FileManager.default.fileExists(
            atPath: Self.modelsRoot.appendingPathComponent(folder).path)
    }

    /// Where each key's weights sit under the TTS cache root. Stated here for
    /// the same reason the transcription server states its own: the mapping is
    /// runtime knowledge, and a key is listed because its weights are on this
    /// machine rather than because a driver exists for it.
    private static func folder(for key: String) -> String? {
        switch key {
        case "pocket-tts": return "pocket-tts-coreml"
        case "kokoro-ane": return "kokoro-82m-coreml"
        case "supertonic3": return "supertonic-3"
        case "luxtts": return "luxtts"
        default: return nil
        }
    }

    private static var modelsRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache", isDirectory: true)
            .appendingPathComponent("fluidaudio", isDirectory: true)
            .appendingPathComponent("Models", isDirectory: true)
    }
}

enum TtsRosterError: Error, CustomStringConvertible {
    case missing
    case unreadable(path: String, detail: String)
    case noRoster(path: String, provider: String)
    case noSuchProvider(id: String, path: String)
    case malformed(String)
    case empty
    case unknownKey(id: String, key: String)
    case duplicateId(String)

    var description: String {
        switch self {
        case .missing:
            return
                "no roster: pass --registry <path> and --provider <serviceId>. A server with no roster is misconfigured, not empty"
        case .unreadable(let path, let detail):
            return "registry \(path) could not be read: \(detail)"
        case .noRoster(let path, let provider):
            return "registry \(path) has no roster section, so it has no provider \(provider)"
        case .noSuchProvider(let id, let path):
            return "registry \(path) roster has no provider \(id)"
        case .malformed(let detail):
            return "roster is not valid JSON for the model contract: \(detail)"
        case .empty:
            return
                "roster is empty: a server that offers nothing cannot be told from one whose models have all gone"
        case .unknownKey(let id, let key):
            return "roster model \(id) names key \(key), which this server has no driver for"
        case .duplicateId(let id):
            return "roster names model \(id) twice"
        }
    }
}

/// The roster this server was handed, checked.
struct TtsRoster: Sendable {
    let models: [ValidatedTtsModel]

    func model(id: String) -> ValidatedTtsModel? {
        models.first { $0.id == id }
    }

    /// The runtime key for a platform id, for the driver factory.
    func key(for id: String) -> String? {
        model(id: id)?.key
    }

    /// The platform id for a runtime key — the way back, for reporting what is
    /// resident to a caller that only ever saw the listing.
    func id(forKey key: String) -> String? {
        models.first { $0.key == key }?.id
    }

    static func validate(_ entries: [TtsRosterEntry]) throws -> TtsRoster {
        guard !entries.isEmpty else { throw TtsRosterError.empty }
        var seen = Set<String>()
        var validated: [ValidatedTtsModel] = []
        for entry in entries {
            guard seen.insert(entry.id).inserted else {
                throw TtsRosterError.duplicateId(entry.id)
            }
            guard driverKeys.contains(entry.key) else {
                throw TtsRosterError.unknownKey(id: entry.id, key: entry.key)
            }
            validated.append(ValidatedTtsModel(entry: entry))
        }
        return TtsRoster(models: validated)
    }

    /// Read this server's models from the roster section of the node's
    /// registry — the same file the transcription server and the shard read.
    /// One source, read directly: a per-server copy would be a second thing to
    /// keep in step for the sake of one lookup.
    static func load(registry file: URL, provider: String) throws -> TtsRoster {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch {
            throw TtsRosterError.unreadable(path: file.path, detail: error.localizedDescription)
        }
        let registry: TtsNodeRegistry
        do {
            registry = try JSONDecoder().decode(TtsNodeRegistry.self, from: data)
        } catch {
            throw TtsRosterError.malformed(String(describing: error))
        }
        guard let roster = registry.roster else {
            throw TtsRosterError.noRoster(path: file.path, provider: provider)
        }
        guard let entry = roster.providers[provider] else {
            throw TtsRosterError.noSuchProvider(id: provider, path: file.path)
        }
        return try validate(entry.ttsModels ?? [])
    }
}

/// Just enough of the node's registry to find this server's own models.
private struct TtsNodeRegistry: Decodable {
    let roster: TtsNodeRoster?
}

private struct TtsNodeRoster: Decodable {
    let providers: [String: TtsProviderEntry]
}

private struct TtsProviderEntry: Decodable {
    let ttsModels: [TtsRosterEntry]?
}
