import FluidAudio
import Foundation

/// What a transcription returns, regardless of which manager produced it.
struct TranscriptionOutput: Sendable {
    let text: String
    let duration: Double?
    let tokenTimings: [TokenTiming]
}

/// One live model and the identity of what it is.
///
/// This type owns *every* reference to the loaded CoreML models. `cleanup()` on
/// a manager nils the manager's own references, but the memory is released only
/// when nothing else retains them — and `AsrModels` is a struct holding the same
/// models, so keeping it alongside the manager keeps them alive. Concentrating
/// the references here means dropping this object drops the last one.
///
/// **A model is one entry even where two managers serve it.** Parakeet Unified
/// is one set of weights: the decoder, joint and vocabulary are shared, and only
/// the encoder differs between offline and streaming. Holding it as two entries
/// would report one model as two and make loading both impossible to express.
/// The managers coexist safely — both are actors with no shared singletons, and
/// FluidAudio #661 constrains concurrent *prediction*, which the slot already
/// serialises.
enum LoadedModel {
    case batchTdt(id: String, manager: AsrManager, decoderLayerCount: Int)
    /// Parakeet Unified. At least one manager is present; which ones follows
    /// from the mode the load asked for, so a caller that wanted batch does not
    /// pay for the streaming encoder.
    case unified(id: String, offline: UnifiedAsrManager?, streaming: StreamingUnifiedAsrManager?)
    /// Nemotron, at one latency tier. The tier is a load parameter, not an
    /// identity: three tiers are one model, and each is its own encoder bundle
    /// so holding all three would cost three encoders for a choice made once.
    case nemotron(id: String, manager: StreamingNemotronAsrManager, chunkMs: Int)

    var id: String {
        switch self {
        case .batchTdt(let id, _, _): return id
        case .unified(let id, _, _): return id
        case .nemotron(let id, _, _): return id
        }
    }

    /// Which modes are resident. What the listing reports for a model that can
    /// do both: a boolean cannot say which half is up.
    var modes: [LoadMode] {
        switch self {
        case .batchTdt: return [.batch]
        case .nemotron: return [.streaming]
        case .unified(_, let offline, let streaming):
            var m: [LoadMode] = []
            if offline != nil { m.append(.batch) }
            if streaming != nil { m.append(.streaming) }
            return m
        }
    }

    /// The live session, for the endpoints that drive one.
    var session: StreamingSession? {
        switch self {
        case .unified(_, _, let streaming):
            return streaming.map { .unified($0) }
        case .nemotron(_, let manager, _):
            return .nemotron(manager)
        case .batchTdt:
            return nil
        }
    }

    /// Build the managers `mode` asks for. Only what was asked for is loaded:
    /// residency is a memory decision, and pre-paying for a mode nobody
    /// requested is a cost taken on a guess.
    static func load(
        _ model: ValidatedModel, mode: LoadMode, variant: RosterVariant?
    ) async throws -> LoadedModel {
        switch model.family {
        case .batchTdt(let version):
            // `models` goes out of scope at the end of this call: the manager
            // retains what it needs, and no second reference survives to keep
            // the weights alive across an unload.
            let models = try await AsrModels.downloadAndLoad(version: version)
            let config = ASRConfig(
                tdtConfig: TdtConfig(blankId: version.blankId),
                encoderHiddenSize: version.encoderHiddenSize
            )
            let manager = AsrManager(config: config)
            try await manager.loadModels(models)
            let layers = await manager.decoderLayerCount
            return .batchTdt(id: model.id, manager: manager, decoderLayerCount: layers)

        case .unified:
            var offline: UnifiedAsrManager?
            var streaming: StreamingUnifiedAsrManager?
            if mode == .batch || mode == .both {
                let m = UnifiedAsrManager()
                try await m.loadModels()
                offline = m
            }
            if mode == .streaming || mode == .both {
                let m = StreamingUnifiedAsrManager()
                try await m.loadModels()
                streaming = m
            }
            return .unified(id: model.id, offline: offline, streaming: streaming)

        case .nemotron:
            // The tier is what the variant binds. Validation guarantees every
            // Nemotron variant binds one the manager has.
            guard let ms = variant?.value(of: "chunkMs"), let chunk = NemotronChunkSize(rawValue: ms)
            else { throw RosterError.variantRequired(id: model.id, offered: model.variants) }
            // The default MLModelConfiguration is `.all`, under which CoreML
            // routes this model's int8 operations to GPU and runs about ten
            // times slower. The manager's own default is the ANE path.
            let manager = StreamingNemotronAsrManager(requestedChunkSize: chunk)
            try await manager.loadModels()
            return .nemotron(id: model.id, manager: manager, chunkMs: chunk.rawValue)
        }
    }

    /// Add a mode to what is already resident, keeping what is there.
    ///
    /// Only Unified has a second mode to add. Returning nil says nothing was
    /// added, so a caller knows the request was already satisfied rather than
    /// silently ignored.
    func adding(mode: LoadMode) async throws -> LoadedModel? {
        guard case .unified(let id, let offline, let streaming) = self else { return nil }
        var newOffline = offline
        var newStreaming = streaming
        var changed = false
        if (mode == .batch || mode == .both), offline == nil {
            let m = UnifiedAsrManager()
            try await m.loadModels()
            newOffline = m
            changed = true
        }
        if (mode == .streaming || mode == .both), streaming == nil {
            let m = StreamingUnifiedAsrManager()
            try await m.loadModels()
            newStreaming = m
            changed = true
        }
        guard changed else { return nil }
        return .unified(id: id, offline: newOffline, streaming: newStreaming)
    }

    /// One-shot transcription. A streaming-only model has no such call — the
    /// caller checks first and says so rather than reaching here.
    func transcribe(url: URL) async throws -> TranscriptionOutput {
        switch self {
        case .nemotron(let id, _, _):
            throw FluidServerSTTError.streamingModelSelected(id)

        case .batchTdt(_, let manager, let layers):
            var state = TdtDecoderState.make(decoderLayers: layers)
            let result = try await manager.transcribe(url, decoderState: &state)
            return TranscriptionOutput(
                text: result.text,
                duration: result.duration,
                tokenTimings: result.tokenTimings ?? []
            )

        case .unified(let id, let offline, _):
            // Resident as streaming only: the weights for a one-shot call were
            // never brought up, and saying so is better than transcribing with
            // the wrong encoder.
            guard let manager = offline else {
                throw FluidServerSTTError.modeNotLoaded(id: id, mode: LoadMode.batch.rawValue)
            }
            let samples = try AudioConverter().resampleAudioFile(url)
            let result = try await manager.transcribeWithTimings(samples)
            return TranscriptionOutput(
                text: result.text,
                duration: Double(samples.count) / 16000.0,
                tokenTimings: result.tokenTimings
            )
        }
    }

    /// Release the managers' models. Refcount-based, so this only frees if the
    /// caller also drops this object — see the type comment.
    ///
    /// `AsrManager.cleanup()` is sync and clears a *shared* array cache in an
    /// unawaited `Task`, so that clear is still outstanding when it returns.
    /// Anything measuring memory straight afterwards has to allow for it.
    func unload() async {
        switch self {
        case .batchTdt(_, let manager, _):
            await manager.cleanup()
        case .unified(_, let offline, let streaming):
            await offline?.cleanup()
            await streaming?.cleanup()
        case .nemotron(_, let manager, _):
            await manager.cleanup()
        }
    }
}
