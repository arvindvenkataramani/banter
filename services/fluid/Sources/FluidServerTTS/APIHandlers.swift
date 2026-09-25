import FluidServerKit
import Foundation
import OpenAPIRuntime

/// The model-lifecycle surface, implementing the protocol generated from
/// `openapi.yaml`.
///
/// The spec is the source of truth: this type must satisfy what the generator
/// produces from it, so a route cannot drift from its documentation without
/// failing to compile. That is also what keeps this server and the
/// transcription server answering these endpoints identically — the shapes are
/// the same in both specs, and neither can quietly change one.
///
/// Synthesis itself is not here. `/v1/audio/speech` takes the union of what
/// nine backends accept and returns audio, and `/v1/audio/stream` is a
/// WebSocket; both stay hand-written.
struct APIHandlers: APIProtocol {
    let ctx: TtsAppContext

    func getHealth(_ input: Operations.getHealth.Input) async throws
        -> Operations.getHealth.Output
    {
        let model = await ctx.resident.currentModel
        return .ok(.init(body: .json(.init(status: "ok", model: model))))
    }

    func listModels(_ input: Operations.listModels.Input) async throws
        -> Operations.listModels.Output
    {
        let loaded = await ctx.resident.currentModel
        let data = ctx.roster.models.map { model in
            Components.Schemas.Model(
                id: model.id,
                name: model.name,
                object: "model",
                created: processStart,
                owned_by: "fluidaudio",
                // The slot holds the runtime key, since that is what built the
                // driver; the listing reports platform ids, so compare keys.
                loaded: model.key == loaded,
                // Kept because OpenAI-compatible clients read it, not because
                // anything here is unloadable: every roster model loads.
                loadable: true,
                kind: .init(rawValue: model.kind) ?? .both,
                transport: model.transports.compactMap {
                    Components.Schemas.Model.transportPayloadPayload(rawValue: $0)
                },
                present: model.present,
                canClone: model.canClone,
                requiresRefText: model.requiresRefText,
                // The whole rule, not just the two flags a caller reads most
                // often: a consumer deciding whether a recording will be
                // accepted needs every term the roster states.
                cloning: model.cloning.map {
                    .init(
                        available: $0.available,
                        requiresText: $0.requiresText,
                        minDurationS: $0.minDurationS,
                        maxDurationS: $0.maxDurationS,
                        sampleRate: $0.sampleRate)
                },
                chunkProfile: model.chunkProfile.map {
                    .init(words: $0.words, chars: $0.chars)
                },
                presetVoices: model.presetVoices.map {
                    .init(id: $0.id, name: $0.name)
                }
            )
        }
        return .ok(.init(body: .json(.init(object: "list", data: data))))
    }

    func loadModel(_ input: Operations.loadModel.Input) async throws
        -> Operations.loadModel.Output
    {
        guard case .json(let body) = input.body else {
            return .badRequest(.init(body: .json(.init(error: "expected a JSON body"))))
        }
        switch try await load(body.model) {
        case .loaded: return .ok(.init())
        case .unknown(let error): return .badRequest(.init(body: .json(.init(error: error))))
        case .refused(let error): return .conflict(.init(body: .json(.init(error: error))))
        }
    }

    func loadModelByName(_ input: Operations.loadModelByName.Input) async throws
        -> Operations.loadModelByName.Output
    {
        switch try await load(input.query.model_name) {
        case .loaded: return .ok(.init())
        case .unknown(let error): return .badRequest(.init(body: .json(.init(error: error))))
        case .refused(let error): return .conflict(.init(body: .json(.init(error: error))))
        }
    }

    private enum LoadOutcome {
        case loaded
        case unknown(String)
        case refused(String)
    }

    /// The one load both spellings share.
    private func load(_ id: String) async throws -> LoadOutcome {
        // Resolve through the roster, not straight to the driver factory: the
        // roster is what this server offers, and its id is the platform's
        // while the driver wants the runtime's key. Skipping it would load a
        // model the roster deliberately left out.
        guard let key = ctx.roster.key(for: id) else {
            return .unknown(TtsError.unknownModel(id).description)
        }
        do {
            try await ctx.resident.load(key)
        } catch let error as TtsError {
            if case .unknownModel = error { return .unknown(error.description) }
            return .refused(error.description)
        } catch let error as SlotError {
            return .refused(error.description)
        }
        return .loaded
    }

    func unloadModel(_ input: Operations.unloadModel.Input) async throws
        -> Operations.unloadModel.Output
    {
        do {
            try await ctx.resident.unload()
        } catch let error as SlotError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        } catch let error as TtsError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        }
        return .ok(.init())
    }
}
