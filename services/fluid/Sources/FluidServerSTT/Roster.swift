import FluidAudio
import Foundation

/// What this server was told to offer.
///
/// The server does not decide which models exist. It is handed a roster at
/// start and validates that it can serve what it names — a roster entry it
/// cannot map to a manager is a startup failure naming the id, not a model
/// quietly missing from the listing.
///
/// Contract: `schemas/platform.schema.json#/$defs/sttModel`. Design record:
/// `docs/design/model-roster.md`.

/// What a model can do. The roster declares this; the server checks it against
/// what the code can actually build for that key.
enum ModelKind: String, Sendable, Codable {
    case batch
    case streaming
    case both

    var servesBatch: Bool { self == .batch || self == .both }
    var servesStreaming: Bool { self == .streaming || self == .both }
}

/// Which mode a load asks for. A model that does one thing needs none; a model
/// that does both is refused without one rather than defaulted, so a caller
/// never discovers the wrong choice as unexplained latency.
enum LoadMode: String, Sendable, Codable {
    case batch
    case streaming
    case both
}

/// One model as the roster declares it.
struct RosterEntry: Sendable, Codable {
    /// The platform's identity for this model — what a selection names.
    let id: String
    let name: String
    /// The identifier this runtime reaches the model by. What files it resolves
    /// to, in which cache root, is FluidAudio's business and not the roster's.
    let key: String
    let kind: ModelKind
    /// What a load accepts, each with the values it may take.
    let params: [RosterParam]?
    /// The distinct sets of weights under this id, each naming the parameter
    /// values that select it. Absent, the model has one implicit variant.
    let variants: [RosterVariant]?
}

/// A parameter a load accepts.
struct RosterParam: Sendable, Codable, Equatable {
    let name: String
    let values: [Int]
}

/// One parameter at one value.
struct ParamBinding: Sendable, Codable, Equatable, Hashable {
    let name: String
    let value: Int
}

/// One set of weights under a model's id. `params` is the mapping from
/// parameter values to this variant — the whole of the coupling between the
/// two, and data rather than code.
struct RosterVariant: Sendable, Codable, Equatable {
    let id: String
    let params: [ParamBinding]

    /// The value this variant binds `name` to, if it binds it.
    func value(of name: String) -> Int? {
        params.first { $0.name == name }?.value
    }

    /// Whether `given` selects this variant: every binding here is given, at
    /// the same value.
    func isSelected(by given: [ParamBinding]) -> Bool {
        params.allSatisfy { binding in given.contains(binding) }
    }
}

/// Which manager family a roster key resolves to.
///
/// This is the irreducible code: a JSON file cannot name a Swift class. It is
/// also the whole of it — everything else about a model is data the roster
/// carries.
enum ManagerFamily: Sendable {
    case batchTdt(AsrModelVersion)
    case unified
    case nemotron

    /// What the code can build for this family, which the roster's declared
    /// kind must not exceed.
    var supports: ModelKind {
        switch self {
        case .batchTdt: return .batch
        case .unified: return .both
        case .nemotron: return .streaming
        }
    }

    /// What building this family's manager needs, each with the values the
    /// code can build. A roster's parameters must be among these, and every
    /// variant must bind all of them: they are what makes one variant's
    /// weights differ from another's.
    var buildParams: [String: [Int]] {
        switch self {
        case .nemotron: return ["chunkMs": NemotronChunkSize.allCases.map(\.rawValue)]
        case .batchTdt, .unified: return [:]
        }
    }

    /// The keys this server can build a manager for.
    ///
    /// FluidAudio offers more TDT versions than these. A key is here because
    /// its weights are on this machine, not because upstream has a case for
    /// it — enumerating the enum is what put a model with no weights in the
    /// listing in the first place.
    static func resolve(key: String) -> ManagerFamily? {
        switch key {
        case "parakeet-tdt-v3": return .batchTdt(.v3)
        case "parakeet-unified-0.6b": return .unified
        case "nemotron-streaming-en-0.6b": return .nemotron
        default: return nil
        }
    }
}

/// A roster entry the server has checked it can serve.
struct ValidatedModel: Sendable {
    let entry: RosterEntry
    let family: ManagerFamily

    var id: String { entry.id }
    var name: String { entry.name }
    var kind: ModelKind { entry.kind }
    /// What the roster says this model accepts and which weights it has.
    /// Reported in the listing so a caller can discover the choice rather than
    /// learn it from a refusal.
    var params: [RosterParam] { entry.params ?? [] }
    var variants: [RosterVariant] { entry.variants ?? [] }

    /// How this model is reached. A set rather than one value: a model that
    /// does both is genuinely served over the transcription endpoint and the
    /// socket, and collapsing that asserts a coupling the server does not
    /// guarantee.
    var transports: [String] {
        var t: [String] = []
        if kind.servesBatch { t.append("http") }
        if kind.servesStreaming { t.append("websocket") }
        return t
    }

    /// Whether every component this model needs is on disk, in the cache root
    /// FluidAudio itself reads. Not availability — that is a platform fact —
    /// but the one input only this server can contribute.
    var present: Bool {
        switch family {
        case .batchTdt(let version):
            // `modelsExist` strips a component before appending the repo's
            // folder name, so it wants a path *inside* the models root rather
            // than the root itself. Passing the root looks one level too high
            // and reports every TDT model absent.
            return AsrModels.modelsExist(
                at: Self.asrModelsRoot.appendingPathComponent(Self.tdtFolder(version)),
                version: version)
        case .unified:
            return Self.hasFiles(
                in: Repo.parakeetUnified.folderName,
                // The encoders are per-mode, so presence follows what the model
                // declares: a streaming-only entry must not be called absent
                // because the offline encoder was never fetched.
                any: encoderFiles,
                all: [
                    ModelNames.ParakeetUnified.decoderFile,
                    ModelNames.ParakeetUnified.jointDecisionFile,
                    ModelNames.ParakeetUnified.vocab,
                ])
        case .nemotron:
            // Each variant is its own encoder bundle under its own
            // subdirectory, so a model is present only if all its variants are.
            return !variants.isEmpty && variants.allSatisfy { variant in
                guard let ms = variant.value(of: "chunkMs"),
                    let size = NemotronChunkSize(rawValue: ms)
                else { return false }
                return FileManager.default.fileExists(
                    atPath: Self.asrModelsRoot.appendingPathComponent(size.repo.folderName).path)
            }
        }
    }

    /// Where a TDT version's weights sit under the models root.
    /// `AsrModelVersion.repo` is internal to FluidAudio, so the mapping is
    /// stated here — the same kind of runtime-key knowledge the roster already
    /// resolves, and it changes only when upstream renames a repo.
    private static func tdtFolder(_ version: AsrModelVersion) -> String {
        switch version {
        case .v3: return "parakeet-tdt-0.6b-v3"
        // Every other version upstream defines is one this machine has no
        // weights for. Reaching here means `resolve(key:)` gained a case
        // without this gaining its folder.
        default: return ""
        }
    }

    /// The unified encoders this entry's kind actually requires.
    private var encoderFiles: [String] {
        var files: [String] = []
        if kind.servesBatch {
            files.append(ModelNames.ParakeetUnified.offlineEncoderFile(precision: .int8))
        }
        if kind.servesStreaming {
            // The default context suffix, which is what the manager's own
            // default config resolves to and what is on disk.
            files.append(
                ModelNames.ParakeetUnified.streamingEncoderFile(precision: .int8))
        }
        return files
    }

    /// ASR weights live under Application Support; TTS uses a different root.
    /// Both are FluidAudio's own conventions, which is why presence is asked of
    /// the runtime rather than reconstructed by the platform.
    private static var asrModelsRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("FluidAudio", isDirectory: true)
            .appendingPathComponent("Models", isDirectory: true)
    }

    private static func hasFiles(in folder: String, any: [String], all: [String]) -> Bool {
        let dir = asrModelsRoot.appendingPathComponent(folder)
        let fm = FileManager.default
        let everyRequired = all.allSatisfy { fm.fileExists(atPath: dir.appendingPathComponent($0).path) }
        let someEncoder = any.allSatisfy { fm.fileExists(atPath: dir.appendingPathComponent($0).path) }
        return everyRequired && someEncoder && !any.isEmpty
    }

    /// Which mode a load request resolves to, or why it cannot.
    ///
    /// A model with one capability decides for itself. A model with two is a
    /// choice, and an unnamed choice is refused rather than defaulted.
    func resolve(mode requested: LoadMode?) throws -> LoadMode {
        switch (kind, requested) {
        case (.both, .none):
            throw RosterError.modeRequired(id)
        case (.both, .some(let m)):
            return m
        case (.batch, .none), (.batch, .some(.batch)):
            return .batch
        case (.streaming, .none), (.streaming, .some(.streaming)):
            return .streaming
        case (.batch, .some(let m)), (.streaming, .some(let m)):
            throw RosterError.modeUnsupported(id: id, requested: m, kind: kind)
        }
    }

    /// Which variant a load resolves to, or why it cannot, read from the
    /// declaration alone: a named variant as named, else the one the given
    /// parameters select, else the model's implicit one (nil). Same rule as
    /// mode: where the model offers a choice, it must be made.
    func resolve(variant named: String?, params given: [ParamBinding]) throws -> RosterVariant? {
        for binding in given {
            guard let param = params.first(where: { $0.name == binding.name }) else {
                throw RosterError.paramUnsupported(id: id, param: binding.name)
            }
            guard param.values.contains(binding.value) else {
                throw RosterError.paramValueUnknown(
                    id: id, param: binding.name, value: binding.value, offered: param.values)
            }
        }

        if let named {
            guard let variant = variants.first(where: { $0.id == named }) else {
                throw RosterError.variantUnknown(
                    id: id, requested: named, offered: variants.map(\.id))
            }
            // A parameter the variant binds, given at another value, selects
            // something else; either silent winner misreports what is resident.
            for binding in given {
                if let bound = variant.value(of: binding.name), bound != binding.value {
                    let selects = variants.first { $0.isSelected(by: given) }?.id
                    throw RosterError.variantConflict(
                        id: id, variant: named, param: binding, selects: selects)
                }
            }
            return variant
        }

        if variants.isEmpty { return nil }
        let selected = variants.filter { $0.isSelected(by: given) }
        guard selected.count == 1 else {
            throw RosterError.variantRequired(id: id, offered: variants)
        }
        return selected[0]
    }
}

enum RosterError: Error, CustomStringConvertible {
    case missing
    case unreadable(path: String, detail: String)
    case noRoster(path: String, provider: String)
    case noSuchProvider(id: String, path: String)
    case malformed(String)
    case empty
    case unknownKey(id: String, key: String)
    case kindUnsupported(id: String, declared: ModelKind, supports: ModelKind)
    case duplicateId(String)
    case duplicateParam(id: String, param: String)
    case paramUnusable(id: String, param: String)
    case paramValueUnusable(id: String, param: String, value: Int)
    case variantsUnsupported(id: String)
    case variantsRequired(id: String, param: String)
    case duplicateVariant(id: String, variant: String)
    case variantParamUndeclared(id: String, variant: String, param: String)
    case variantValueUndeclared(id: String, variant: String, param: String, value: Int)
    case variantMissingParam(id: String, variant: String, param: String)
    case variantsIndistinct(id: String, first: String, second: String)
    case modeRequired(String)
    case modeUnsupported(id: String, requested: LoadMode, kind: ModelKind)
    case paramUnsupported(id: String, param: String)
    case paramValueUnknown(id: String, param: String, value: Int, offered: [Int])
    case variantUnknown(id: String, requested: String, offered: [String])
    case variantConflict(id: String, variant: String, param: ParamBinding, selects: String?)
    case variantRequired(id: String, offered: [RosterVariant])

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
            return "roster is empty: a server that offers nothing cannot be told from one whose models have all gone"
        case .unknownKey(let id, let key):
            return "roster model \(id) names key \(key), which this server has no manager for"
        case .kindUnsupported(let id, let declared, let supports):
            return
                "roster model \(id) declares kind \(declared.rawValue), but its manager supports only \(supports.rawValue)"
        case .duplicateId(let id):
            return "roster names model \(id) twice"
        case .duplicateParam(let id, let param):
            return "roster model \(id) declares parameter \(param) twice"
        case .paramUnusable(let id, let param):
            return "roster model \(id) declares parameter \(param), which its manager does not take"
        case .paramValueUnusable(let id, let param, let value):
            return "roster model \(id) offers \(param) \(value), which its manager cannot build"
        case .variantsUnsupported(let id):
            return "roster model \(id) declares variants, but its manager builds only one"
        case .variantsRequired(let id, let param):
            return "roster model \(id) declares no variants, but its manager cannot be built without \(param)"
        case .duplicateVariant(let id, let variant):
            return "roster model \(id) declares variant \(variant) twice"
        case .variantParamUndeclared(let id, let variant, let param):
            return "roster model \(id) variant \(variant) binds \(param), which the model does not declare"
        case .variantValueUndeclared(let id, let variant, let param, let value):
            return "roster model \(id) variant \(variant) binds \(param) \(value), which the model does not offer"
        case .variantMissingParam(let id, let variant, let param):
            return "roster model \(id) variant \(variant) does not bind \(param), which its manager needs"
        case .variantsIndistinct(let id, let first, let second):
            return "roster model \(id) variants \(first) and \(second) are selected by the same parameters"
        case .modeRequired(let id):
            return
                "\(id) serves batch and streaming; say which with \"mode\": \"batch\", \"streaming\" or \"both\""
        case .modeUnsupported(let id, let requested, let kind):
            return "\(id) is a \(kind.rawValue) model and cannot load as \(requested.rawValue)"
        case .paramUnsupported(let id, let param):
            return "\(id) takes no parameter \(param)"
        case .paramValueUnknown(let id, let param, let value, let offered):
            return
                "\(id) does not offer \(param) \(value); it offers \(offered.map(String.init).joined(separator: ", "))"
        case .variantUnknown(let id, let requested, let offered):
            return offered.isEmpty
                ? "\(id) has no variants; it cannot load as \(requested)"
                : "\(id) has no variant \(requested); it offers \(offered.joined(separator: ", "))"
        case .variantConflict(let id, let variant, let param, let selects):
            let other = selects.map { ", which selects \($0)" } ?? ""
            return "\(id): variant \(variant) was named with \(param.name) \(param.value)\(other)"
        case .variantRequired(let id, let offered):
            return
                "\(id) offers variants \(offered.map(Self.describe).joined(separator: ", ")); say which with \"variant\" or its parameters"
        }
    }

    /// A variant as a caller would choose it: its id and what selects it.
    private static func describe(_ variant: RosterVariant) -> String {
        let bindings = variant.params.map { "\($0.name) \($0.value)" }.joined(separator: ", ")
        return bindings.isEmpty ? variant.id : "\(variant.id) (\(bindings))"
    }
}

/// The roster this server was handed, checked.
struct Roster: Sendable {
    let models: [ValidatedModel]

    func model(id: String) -> ValidatedModel? {
        models.first { $0.id == id }
    }

    /// Parse and validate. Every failure names the offending model, because a
    /// roster that is wrong should say which line is wrong.
    static func validate(_ entries: [RosterEntry]) throws -> Roster {
        guard !entries.isEmpty else { throw RosterError.empty }

        var seen = Set<String>()
        var validated: [ValidatedModel] = []

        for entry in entries {
            guard seen.insert(entry.id).inserted else {
                throw RosterError.duplicateId(entry.id)
            }
            guard let family = ManagerFamily.resolve(key: entry.key) else {
                throw RosterError.unknownKey(id: entry.id, key: entry.key)
            }
            // A roster may offer less than the code supports — that is the
            // subset control it exists for — but never more.
            let supported = family.supports
            if supported != .both && entry.kind != supported {
                throw RosterError.kindUnsupported(
                    id: entry.id, declared: entry.kind, supports: supported)
            }
            try validateVariants(entry, family: family)
            validated.append(ValidatedModel(entry: entry, family: family))
        }
        return Roster(models: validated)
    }

    /// The declaration must be one the code can build: every parameter one the
    /// manager takes, at values it has, and every variant binding all of them,
    /// so each names weights that exist and no two name the same ones.
    private static func validateVariants(_ entry: RosterEntry, family: ManagerFamily) throws {
        let id = entry.id
        let params = entry.params ?? []
        let variants = entry.variants ?? []
        let buildable = family.buildParams

        var paramNames = Set<String>()
        for param in params {
            guard paramNames.insert(param.name).inserted else {
                throw RosterError.duplicateParam(id: id, param: param.name)
            }
            guard let available = buildable[param.name] else {
                throw RosterError.paramUnusable(id: id, param: param.name)
            }
            for value in param.values where !available.contains(value) {
                throw RosterError.paramValueUnusable(id: id, param: param.name, value: value)
            }
        }

        if buildable.isEmpty {
            if !variants.isEmpty { throw RosterError.variantsUnsupported(id: id) }
            return
        }
        if variants.isEmpty {
            throw RosterError.variantsRequired(id: id, param: buildable.keys.sorted()[0])
        }

        var variantIds = Set<String>()
        var selections: [(id: String, params: Set<ParamBinding>)] = []
        for variant in variants {
            guard variantIds.insert(variant.id).inserted else {
                throw RosterError.duplicateVariant(id: id, variant: variant.id)
            }
            for binding in variant.params {
                guard let param = params.first(where: { $0.name == binding.name }) else {
                    throw RosterError.variantParamUndeclared(
                        id: id, variant: variant.id, param: binding.name)
                }
                guard param.values.contains(binding.value) else {
                    throw RosterError.variantValueUndeclared(
                        id: id, variant: variant.id, param: binding.name, value: binding.value)
                }
            }
            for name in buildable.keys.sorted() where variant.value(of: name) == nil {
                throw RosterError.variantMissingParam(id: id, variant: variant.id, param: name)
            }
            let selection = Set(variant.params)
            if let twin = selections.first(where: { $0.params == selection }) {
                throw RosterError.variantsIndistinct(id: id, first: twin.id, second: variant.id)
            }
            selections.append((variant.id, selection))
        }
    }

    /// Read this server's models from the roster section of the node's
    /// registry.
    ///
    /// One file for the whole node, read directly rather than copied into a
    /// per-server one: a derived file is a second thing to keep in step, and
    /// what it buys — the server not knowing the platform's shape — costs only
    /// this one lookup. A path rather than contents, and declared in the
    /// registry, so what a running server loaded is always attributable to a
    /// file that can be read.
    static func load(registry file: URL, provider: String) throws -> Roster {
        let data: Data
        do {
            data = try Data(contentsOf: file)
        } catch {
            throw RosterError.unreadable(path: file.path, detail: error.localizedDescription)
        }
        let registry: NodeRegistry
        do {
            registry = try JSONDecoder().decode(NodeRegistry.self, from: data)
        } catch {
            throw RosterError.malformed(String(describing: error))
        }
        guard let roster = registry.roster else {
            throw RosterError.noRoster(path: file.path, provider: provider)
        }
        guard let entry = roster.providers[provider] else {
            throw RosterError.noSuchProvider(id: provider, path: file.path)
        }
        // A provider with no transcription models is a misconfiguration rather
        // than an empty server: something named this service as an STT
        // provider and gave it nothing to serve.
        return try validate(entry.sttModels ?? [])
    }
}

/// Just enough of the node's registry to find this server's own models.
/// Everything else in the file — services, voices, other providers, synthesis
/// models — is read by whoever needs it, and ignored here.
private struct NodeRegistry: Decodable {
    let roster: NodeRoster?
}

private struct NodeRoster: Decodable {
    let providers: [String: ProviderEntry]
}

private struct ProviderEntry: Decodable {
    let sttModels: [RosterEntry]?
}
