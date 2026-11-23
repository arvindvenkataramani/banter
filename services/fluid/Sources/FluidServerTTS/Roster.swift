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
/// Contract: `schemas/platform.schema.json#/$defs/nodeRoster`. Design record:
/// `docs/reference/design/model-roster.md`.

/// One synthesis model as the roster declares it, whichever runtime serves it.
struct TtsRosterEntry: Sendable, Codable {
    /// The platform's identity for this model — what a selection names.
    let id: String
    let name: String
    /// What cloning demands of a recording, where the model can clone at all.
    /// Absent means it cannot.
    let cloning: TtsCloning?
    /// The model's own chunker constraint. Carried so a caller can respect it
    /// rather than discover it as degraded audio.
    let chunkProfile: TtsChunkProfile?
}

struct TtsChunkProfile: Sendable, Codable {
    let words: Int
    let chars: Int
}

/// One model this runtime serves. `key` is what this runtime calls it:
/// `pocket-tts` here and `mlx-community/pocket-tts` under mlx-audio are one
/// model addressed by two runtimes.
struct TtsServing: Sendable, Codable {
    let model: String
    let key: String
}

/// What a model demands of a cloning recording.
struct TtsCloning: Sendable, Codable {
    let requiresText: Bool?
    let minDurationS: Double?
    let maxDurationS: Double?
    let sampleRate: Int?

    /// Whether a recording meets these demands, length bounds inclusive. The
    /// same arithmetic as `satisfies` in `control/shared/src/roster.ts`.
    func accepts(_ recording: TtsRecording) -> Bool {
        if requiresText == true && recording.text.isEmpty { return false }
        if let minDurationS, recording.durationS < minDurationS { return false }
        if let maxDurationS, recording.durationS > maxDurationS { return false }
        if let sampleRate, recording.sampleRate != sampleRate { return false }
        return true
    }
}

/// Audio of a voice that models clone her from.
struct TtsRecording: Sendable, Codable {
    let audio: String
    /// Path to the recording's transcript.
    let text: String
    let durationS: Double
    let sampleRate: Int
}

/// A voice as produced by one model: a preset (`key` is the model's own name
/// for her) or a clone from one of her recordings.
struct TtsRendering: Sendable, Codable {
    let model: String
    let method: String
    let key: String?
}

/// A person, with a name, her recordings and the models that produce her.
struct TtsVoice: Sendable, Codable {
    let id: String
    let name: String
    let recordings: [TtsRecording]?
    let renderings: [TtsRendering]
}

/// What a driver is given for a voice name under one of this server's models.
enum ResolvedVoice: Equatable, Sendable {
    /// The model's own name for a roster voice.
    case preset(String)
    /// A recording to clone from. `text` is the path to its transcript, and is
    /// present only when the model requires one.
    case clone(audio: String, text: String?)
}

/// A roster model the server has checked it can build a driver for.
struct ValidatedTtsModel: Sendable {
    let entry: TtsRosterEntry
    /// This runtime's key for the model, from its serving.
    let key: String

    var id: String { entry.id }
    var name: String { entry.name }
    var cloning: TtsCloning? { entry.cloning }
    var chunkProfile: TtsChunkProfile? { entry.chunkProfile }

    /// Every synthesis model serves both routes: the file consumer posts and
    /// the voice loop upgrades to the socket, on one port. Reported as a set
    /// rather than assumed, because the client should read it rather than
    /// know it.
    var transports: [String] { ["http", "websocket"] }

    /// Synthesis is not batch-or-streaming the way transcription is — the same
    /// driver serves a one-shot request and a stream. Every model is `both`.
    var kind: String { "both" }

    var canClone: Bool { entry.cloning != nil }
    var requiresRefText: Bool { entry.cloning?.requiresText ?? false }

    /// Whether this model's weights are in the cache root its own runtime
    /// reads. TTS uses `~/.cache/fluidaudio/`, which is not where the ASR
    /// models live — asking the runtime rather than assuming one root is what
    /// keeps this honest.
    var present: Bool {
        guard let folder = Self.folder(for: key) else { return false }
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
    case undeclaredModel(String)

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
        case .undeclaredModel(let id):
            return "roster serves model \(id), which ttsModels does not declare"
        }
    }
}

/// The roster this server was handed, checked.
struct TtsRoster: Sendable {
    let models: [ValidatedTtsModel]
    /// Every voice the node's roster declares, whichever provider offers her.
    let voices: [TtsVoice]
    /// This server's own provider id.
    let provider: String

    init(models: [ValidatedTtsModel], voices: [TtsVoice] = [], provider: String = "") {
        self.models = models
        self.voices = voices
        self.provider = provider
    }

    /// Resolves a voice name for one of this server's models, by the rule in
    /// `docs/reference/design/model-roster.md`. Its TypeScript twin is `resolveVoiceForModel` in
    /// `control/shared/src/roster.ts`; `schemas/voice-resolution-cases.json`
    /// holds the cases both are tested against. A name that is not a declared
    /// voice with a rendering on the model is refused.
    func resolve(voice name: String, model id: String) throws -> ResolvedVoice {
        guard model(id: id) != nil,
            let voice = voices.first(where: { $0.id == name }),
            let rendering = voice.renderings.first(where: { $0.model == id })
        else {
            throw TtsError.voiceNotOffered(voice: name, model: id)
        }
        if rendering.method == "preset", let key = rendering.key { return .preset(key) }

        guard let cloning = model(id: id)?.cloning,
            let recording = (voice.recordings ?? []).first(where: { cloning.accepts($0) })
        else {
            throw TtsError.noUsableReference(voice: name, model: id)
        }
        return .clone(
            audio: recording.audio, text: cloning.requiresText == true ? recording.text : nil)
    }

    /// The voices with a preset rendering on a model, for the model listing.
    func presetVoices(on id: String) -> [TtsVoice] {
        voices.filter { voice in
            voice.renderings.contains { $0.model == id && $0.method == "preset" }
        }
    }

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

    /// The models this provider serves, each by its serving's key.
    static func validate(
        models: [TtsRosterEntry], serves: [TtsServing], voices: [TtsVoice] = [],
        provider: String = ""
    ) throws -> TtsRoster {
        guard !serves.isEmpty else { throw TtsRosterError.empty }
        var seen = Set<String>()
        var validated: [ValidatedTtsModel] = []
        for serving in serves {
            guard let entry = models.first(where: { $0.id == serving.model }) else {
                throw TtsRosterError.undeclaredModel(serving.model)
            }
            guard seen.insert(entry.id).inserted else {
                throw TtsRosterError.duplicateId(entry.id)
            }
            guard driverKeys.contains(serving.key) else {
                throw TtsRosterError.unknownKey(id: entry.id, key: serving.key)
            }
            validated.append(ValidatedTtsModel(entry: entry, key: serving.key))
        }
        return TtsRoster(models: validated, voices: voices, provider: provider)
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
        return try validate(
            models: roster.ttsModels ?? [], serves: entry.serves ?? [],
            voices: roster.voices ?? [], provider: provider)
    }
}

/// Just enough of the node's registry to find this server's own servings, the
/// models they name and the voices those render.
private struct TtsNodeRegistry: Decodable {
    let roster: TtsNodeRoster?
}

private struct TtsNodeRoster: Decodable {
    let ttsModels: [TtsRosterEntry]?
    let providers: [String: TtsProviderEntry]
    let voices: [TtsVoice]?
}

private struct TtsProviderEntry: Decodable {
    let serves: [TtsServing]?
}
