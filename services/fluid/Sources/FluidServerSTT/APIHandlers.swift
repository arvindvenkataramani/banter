import FluidServerKit
import Foundation
import OpenAPIRuntime

/// The HTTP surface, implementing the protocol generated from `openapi.yaml`.
///
/// The spec is the source of truth: this type must satisfy what the generator
/// produces from it, so a route cannot drift from its documentation without
/// failing to compile. The WebSocket endpoint is not here — OpenAPI has no
/// WebSocket concept, so it stays hand-written in `StreamRoutes.swift`.
struct APIHandlers: APIProtocol {
    let ctx: AppContext

    func getHealth(_ input: Operations.getHealth.Input) async throws
        -> Operations.getHealth.Output
    {
        let model = await ctx.resident.loadedId
        let variant = await ctx.resident.loadedVariant
        return .ok(
            .init(
                body: .json(
                    .init(
                        status: "ok", model: model, variant: variant,
                        bundleIdentifier: ctx.identity.bundleIdentifier,
                        shortVersion: ctx.identity.shortVersion,
                        buildVersion: ctx.identity.buildVersion))))
    }

    func listModels(_ input: Operations.listModels.Input) async throws
        -> Operations.listModels.Output
    {
        let loaded = await ctx.resident.loadedId
        let loadedVariant = await ctx.resident.loadedVariant
        let residentModes = await ctx.resident.residentModes
        let data = await ctx.resident.roster.models.map { model -> Components.Schemas.Model in
            let isLoaded = model.id == loaded
            return Components.Schemas.Model(
                id: model.id,
                name: model.name,
                object: "model",
                created: processStart,
                owned_by: "fluidaudio",
                loaded: isLoaded,
                // Kept because OpenAI-compatible clients read it, not because
                // anything here is unloadable: every roster model loads.
                loadable: true,
                kind: .init(rawValue: model.kind.rawValue) ?? .batch,
                transport: model.transports.compactMap {
                    Components.Schemas.Model.transportPayloadPayload(rawValue: $0)
                },
                present: model.present,
                params: model.params.isEmpty
                    ? nil
                    : model.params.map { .init(name: $0.name, values: $0.values) },
                variants: model.variants.isEmpty
                    ? nil
                    : model.variants.map { variant in
                        .init(
                            id: variant.id,
                            params: variant.params.map { .init(name: $0.name, value: $0.value) })
                    },
                variant: isLoaded ? loadedVariant : nil,
                // Which halves are up, for a model that has two. Absent unless
                // this is the resident one, because nothing else has modes.
                modes: isLoaded
                    ? residentModes.compactMap {
                        Components.Schemas.Model.modesPayloadPayload(rawValue: $0)
                    } : nil
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
        let variant: String?
        do {
            variant = try await ctx.resident.load(
                id: body.model,
                mode: body.mode.map { LoadMode(rawValue: $0.rawValue) ?? .batch },
                variant: body.variant,
                params: body.chunkMs.map { [ParamBinding(name: "chunkMs", value: $0)] } ?? [])
        } catch let error as FluidServerSTTError {
            return loadFailure(error)
        } catch let error as SlotError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        }
        return .ok(
            .init(body: .json(.init(object: "model.load", loaded: body.model, variant: variant))))
    }

    /// The query spelling of a load, with nothing to say about mode, variant
    /// or parameters — the roster refuses a model that needs any of them.
    func loadModelByName(_ input: Operations.loadModelByName.Input) async throws
        -> Operations.loadModelByName.Output
    {
        let id = input.query.model_name
        let variant: String?
        do {
            variant = try await ctx.resident.load(id: id, mode: nil, variant: nil, params: [])
        } catch let error as FluidServerSTTError {
            let payload = Components.Schemas._Error(error: error.description)
            switch error.status {
            case .conflict: return .conflict(.init(body: .json(payload)))
            case .serviceUnavailable: return .serviceUnavailable(.init(body: .json(payload)))
            default: return .badRequest(.init(body: .json(payload)))
            }
        } catch let error as SlotError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        }
        return .ok(.init(body: .json(.init(object: "model.load", loaded: id, variant: variant))))
    }

    func unloadModel(_ input: Operations.unloadModel.Input) async throws
        -> Operations.unloadModel.Output
    {
        guard case .json(let body) = input.body else {
            return .badRequest(.init(body: .json(.init(error: "expected a JSON body"))))
        }
        do {
            try await ctx.resident.unload(id: body.model)
        } catch let error as FluidServerSTTError {
            return unloadFailure(error)
        } catch let error as SlotError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        }
        return .ok(.init(body: .json(.init(object: "model.unload", loaded: body.model))))
    }

    /// Drop whatever is resident, without naming it — the spelling
    /// OpenAI-compatible clients use, and what the synthesis server answers on
    /// the same path.
    func dropResidentModel(_ input: Operations.dropResidentModel.Input) async throws
        -> Operations.dropResidentModel.Output
    {
        guard let loaded = await ctx.resident.loadedId else { return .ok(.init()) }
        do {
            try await ctx.resident.unload(id: loaded)
        } catch let error as SlotError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        } catch let error as FluidServerSTTError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        }
        return .ok(.init())
    }

    // MARK: - Model repository

    func repositoryIndex(_ input: Operations.repositoryIndex.Input) async throws
        -> Operations.repositoryIndex.Output
    {
        var readyOnly = false
        if case .json(let body) = input.body { readyOnly = body.ready ?? false }
        let loaded = await ctx.resident.loadedId
        let entries = ctx.resident.roster.models.map { model in
            Components.Schemas.RepositoryIndexEntry(
                name: model.entry.key,
                state: model.id == loaded ? .READY : .UNAVAILABLE,
                reason: model.id == loaded ? "" : "not resident; one model is resident at a time")
        }
        return .ok(.init(body: .json(readyOnly ? entries.filter { $0.state == .READY } : entries)))
    }

    func repositoryLoad(_ input: Operations.repositoryLoad.Input) async throws
        -> Operations.repositoryLoad.Output
    {
        var parameters: Components.Schemas.RepositoryLoadParameters?
        if case .json(let body) = input.body { parameters = body.parameters }
        if let extra = parameters?.additionalProperties.value.keys.sorted(), !extra.isEmpty {
            let error = "unsupported load parameters: \(extra.joined(separator: ", ")); expected mode or variant"
            return .badRequest(.init(body: .json(.init(error: error))))
        }
        guard let model = ctx.resident.roster.model(key: input.path.name) else {
            let error = FluidServerSTTError.unknownModel(input.path.name).description
            return .badRequest(.init(body: .json(.init(error: error))))
        }
        do {
            try await ctx.resident.load(
                id: model.id, mode: parameters?.mode.map { LoadMode(rawValue: $0.rawValue) ?? .batch },
                variant: parameters?.variant, params: [])
        } catch let error as FluidServerSTTError {
            let payload = Components.Schemas._Error(error: error.description)
            switch error.status {
            case .conflict: return .conflict(.init(body: .json(payload)))
            case .serviceUnavailable: return .serviceUnavailable(.init(body: .json(payload)))
            default: return .badRequest(.init(body: .json(payload)))
            }
        } catch let error as SlotError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        }
        return .ok(.init())
    }

    func repositoryUnload(_ input: Operations.repositoryUnload.Input) async throws
        -> Operations.repositoryUnload.Output
    {
        guard let model = ctx.resident.roster.model(key: input.path.name) else {
            let error = FluidServerSTTError.unknownModel(input.path.name).description
            return .badRequest(.init(body: .json(.init(error: error))))
        }
        do {
            try await ctx.resident.unload(id: model.id)
        } catch let error as FluidServerSTTError {
            let payload = Components.Schemas._Error(error: error.description)
            return error.status == .conflict
                ? .conflict(.init(body: .json(payload))) : .badRequest(.init(body: .json(payload)))
        } catch let error as SlotError {
            return .conflict(.init(body: .json(.init(error: error.description))))
        }
        return .ok(.init())
    }

    // MARK: - Failure mapping
    //
    // Each operation gets its own union of responses from the spec, so the same
    // error maps through a per-operation shape rather than one shared helper.

    private func loadFailure(_ error: FluidServerSTTError) -> Operations.loadModel.Output {
        let payload = Components.Schemas._Error(error: error.description)
        switch error.status {
        case .conflict: return .conflict(.init(body: .json(payload)))
        case .serviceUnavailable: return .serviceUnavailable(.init(body: .json(payload)))
        default: return .badRequest(.init(body: .json(payload)))
        }
    }

    private func unloadFailure(_ error: FluidServerSTTError) -> Operations.unloadModel.Output {
        let payload = Components.Schemas._Error(error: error.description)
        switch error.status {
        case .conflict: return .conflict(.init(body: .json(payload)))
        default: return .badRequest(.init(body: .json(payload)))
        }
    }
}
