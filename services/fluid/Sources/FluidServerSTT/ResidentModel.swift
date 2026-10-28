import FluidAudio
import FluidServerKit
import Foundation
import Logging

/// The STT server's view of the one resident model.
///
/// The lifecycle — one model at a time, one operation at a time, a token that
/// releases the work that took the slot — is `ResidentSlot` in the kit, and the
/// reasoning lives there. What is here is what transcription adds: the manager
/// shapes, and the rule that a request never switches the model out from under
/// a caller: only an explicit load replaces one.
///
/// **Every model loads the same way.** A session manager is weights in memory
/// exactly as a one-shot manager is; that it is later driven over a socket
/// rather than a request is a fact about how it is used, not about how it
/// loads. So `load` builds whatever the catalogue names and puts it in the
/// slot, `/healthz` reports what is actually resident, and the load cost is
/// paid at the call that asked for it.
actor ResidentModel {
    /// What this server was told to offer. It never enumerates — the roster is
    /// the whole of what exists, and an id absent from it is unknown however
    /// well the code could serve it.
    let roster: Roster
    /// Which connection drives the session is the slot's to know: the token it
    /// hands out is what every session call is checked against.
    /// Internal rather than private so tests can install a model without its
    /// weights.
    let slot: ResidentSlot<LoadedModel>
    /// Who holds the streaming session, by session id. Consulted before the
    /// slot: a connection the claim refuses never reaches `beginWork`, so it
    /// cannot displace a live session the caller has no right to.
    let claim = SocketClaim()
    private let logger: Logger
    private let builder: ModelBuilder
    /// The load or mode addition under way, and for which model. Every load
    /// goes through here, so a request finding the slot empty waits on the
    /// load already started instead of starting a second one. Set and checked
    /// with no `await` between, which is what makes the check atomic.
    private var inFlight: (seq: UInt64, id: String, kind: InFlightKind, task: Task<String, Error>)?
    /// A request's load into the empty slot, a request's mode addition, an
    /// explicit load, or an idle unload.
    private enum InFlightKind { case load, add, explicit, unload }
    private var inFlightSeq: UInt64 = 0
    /// When work last touched the model. Reads of what is loaded do not count,
    /// or health probes would keep a model resident forever.
    private var lastWork: ContinuousClock.Instant = .now

    init(
        // How long a request queues behind other non-session work, such as a
        // long file being transcribed. Behind a session it is refused at once.
        roster: Roster, logger: Logger, waitDeadline: Duration = .seconds(120),
        builder: ModelBuilder = .live
    ) {
        self.roster = roster
        self.logger = logger
        self.builder = builder
        self.slot = ResidentSlot(
            waitDeadline: waitDeadline, logger: logger,
            release: { _, model in await model.unload() })
    }

    var loadedId: String? {
        get async { await slot.loadedId }
    }


    /// Which modes the resident model has up, as raw strings for the listing.
    /// Empty when nothing is loaded.
    var residentModes: [String] {
        get async { await (slot.currentModel?.modes ?? []).map(\.rawValue) }
    }

    /// Make `id` resident in `mode`.
    ///
    /// Unloads a *different* model before loading: holding two at once is the
    /// peak this server exists to avoid. Asking for a mode of the model already
    /// resident adds that mode instead, keeping what is there — the unified
    /// weights are shared between modes, so tearing down to add one would pay
    /// the whole load again to gain an encoder.
    ///
    /// A failed load leaves nothing resident, which is the honest state:
    /// claiming the previous model survived would be a lie `/healthz` repeats.
    ///
    /// Which variant loads is read from the roster's declaration: a named one,
    /// or the one the given parameters select. Returns its id, nil for a model
    /// with only its implicit variant.
    @discardableResult
    func load(
        id: String, mode requested: LoadMode?, variant named: String?, params: [ParamBinding]
    ) async throws -> String? {
        guard let model = roster.model(id: id) else {
            throw FluidServerSTTError.unknownModel(id)
        }
        let mode: LoadMode
        let variant: RosterVariant?
        do {
            mode = try model.resolve(mode: requested)
            variant = try model.resolve(variant: named, params: params)
        } catch let error as RosterError {
            throw FluidServerSTTError.roster(error)
        }

        // An explicit load may replace the resident model, so it waits out any
        // load already under way and then holds the in-flight record itself.
        while let pending = inFlight { _ = try? await pending.task.value }
        _ = try await track(id: id, kind: .explicit) { [slot, builder, logger] in
            if await slot.loadedId == id, await slot.loadedVariant == variant?.id,
                let current = await slot.currentModel
            {
                // Already as asked: a no-op, even during a session, so voice
                // mode starting on another device can still reach its takeover.
                let wanted: [LoadMode] = mode == .both ? [.batch, .streaming] : [mode]
                if wanted.allSatisfy(current.modes.contains) { return id }
                try await Self.addMode(
                    mode, to: current, slot: slot, builder: builder, logger: logger)
                return id
            }
            try await slot.load(id: id, variant: variant?.id) {
                try await Self.asLoadFailure(id: id) { try await builder.load(model, mode, variant) }
            }
            return id
        }
        lastWork = .now
        return variant?.id
    }

    /// Make the resident model able to serve a request, loading into an empty
    /// slot if need be, and return its id.
    ///
    /// A request never replaces a resident model: naming another one is a
    /// mismatch. A nameless request uses what is resident, or loads the
    /// roster's default into an empty slot. A model resident without the mode
    /// gains it when its kind serves that mode. A model that needs a load
    /// parameter loads only when `params` selects one of its variants.
    @discardableResult
    func ensure(named: String?, mode: LoadMode, params: [ParamBinding] = []) async throws -> String {
        if let named, roster.model(id: named) == nil {
            throw FluidServerSTTError.unknownModel(named)
        }
        var addedMode = false
        while true {
            if let pending = inFlight {
                do {
                    _ = try await pending.task.value
                } catch {
                    // A failed load into the empty slot is this request's
                    // failure too when it wanted the same model. Anything else
                    // (a refused explicit load, a failed mode addition this
                    // request may not need) says nothing about it.
                    if pending.kind == .load, named == nil || named == pending.id {
                        throw error
                    }
                }
                continue
            }

            let resident = await slot.currentModel
            // The read above yields the actor; a load or unload may have started.
            if inFlight != nil { continue }

            guard let current = resident else {
                let target = try loadTarget(named: named, mode: mode, params: params)
                _ = try await track(id: target.model.id, kind: .load) { [slot, builder] in
                    try await slot.loadIfEmpty(id: target.model.id, variant: target.variant?.id) {
                        try await Self.asLoadFailure(id: target.model.id) {
                            try await builder.load(target.model, target.mode, target.variant)
                        }
                    }
                }
                continue
            }

            let residentId = current.id
            if let named, named != residentId {
                throw FluidServerSTTError.modelMismatch(requested: named, loaded: residentId)
            }
            // Another tier of the same model is another set of weights.
            if let named, !params.isEmpty {
                let loadedVariant = await slot.loadedVariant
                if inFlight != nil { continue }
                try checkTier(named: named, params: params, loaded: loadedVariant)
            }
            if current.modes.contains(mode) {
                lastWork = .now
                return residentId
            }
            if let kind = roster.model(id: residentId)?.kind {
                try Self.check(kind: kind, serves: mode, id: residentId)
            }
            if addedMode {
                throw FluidServerSTTError.modeNotLoaded(id: residentId, mode: mode.rawValue)
            }
            addedMode = true
            _ = try await track(id: residentId, kind: .add) { [slot, builder, logger] in
                guard let model = await slot.currentModel, model.id == residentId else {
                    return residentId
                }
                try await Self.addMode(mode, to: model, slot: slot, builder: builder, logger: logger)
                return residentId
            }
        }
    }

    /// Bring up `mode` beside what `current` already holds.
    ///
    /// Refused at once during a session, before anything is built: the session
    /// is the sole occupant, and building an encoder under it would contend for
    /// the Neural Engine. Behind other work the swap queues. When the swap
    /// cannot happen, what was built is released and the caller told why.
    private static func addMode(
        _ mode: LoadMode, to current: LoadedModel, slot: ResidentSlot<LoadedModel>,
        builder: ModelBuilder, logger: Logger
    ) async throws {
        if await slot.currentWork == .session { throw SlotError.busy(.session) }
        let built = try await asLoadFailure(id: current.id) {
            try await builder.addMode(current, mode)
        }
        guard let extended = built else { return }
        if await slot.replaceInPlace(id: current.id, model: extended) {
            logger.info("added \(mode.rawValue) to resident \(current.id)")
            return
        }
        await extended.releaseAdditions(over: current)
        if let work = await slot.currentWork { throw SlotError.busy(work) }
        throw FluidServerSTTError.modeNotLoaded(id: current.id, mode: mode.rawValue)
    }

    /// Refuse a request for a tier other than the one resident, or for a tier
    /// the model does not offer.
    private nonisolated func checkTier(named: String, params: [ParamBinding], loaded: String?) throws {
        guard let model = roster.model(id: named) else { return }
        let wanted: RosterVariant?
        do {
            wanted = try model.resolve(variant: nil, params: params)
        } catch let error as RosterError {
            throw FluidServerSTTError.roster(error)
        }
        guard let wanted, wanted.id != loaded else { return }
        throw FluidServerSTTError.modelMismatch(
            requested: "\(named) (\(wanted.id))", loaded: "\(named) (\(loaded ?? "default"))")
    }

    /// Drop the resident model if no work has touched it for `interval`.
    /// Refused, and false, while a load is under way or work holds the slot.
    ///
    /// Runs as the in-flight operation, so a request arriving mid-unload waits
    /// and then reloads instead of finding the slot emptied under it.
    func unloadIfIdle(after interval: Duration) async -> Bool {
        guard inFlight == nil, ContinuousClock.now - lastWork >= interval else { return false }
        guard let id = await slot.loadedId else { return false }
        guard inFlight == nil, ContinuousClock.now - lastWork >= interval else { return false }
        // Never throws: a refused unload must not fail the requests waiting on it.
        let unloaded = (try? await track(id: id, kind: .unload) { [slot] in
            do {
                try await slot.unload()
                return id
            } catch {
                return ""
            }
        }) == id
        if unloaded { logger.info("unloaded \(id) after \(interval) without work") }
        return unloaded
    }

    /// Which model and mode a request loads into an empty slot, or why it
    /// cannot.
    private func loadTarget(named: String?, mode: LoadMode, params: [ParamBinding]) throws -> (
        model: ValidatedModel, mode: LoadMode, variant: RosterVariant?
    ) {
        let model: ValidatedModel
        if let named {
            guard let m = roster.model(id: named) else {
                throw FluidServerSTTError.unknownModel(named)
            }
            model = m
        } else {
            guard let fallback = roster.defaultModel else { throw FluidServerSTTError.noModelLoaded }
            model = fallback
        }
        try Self.check(kind: model.kind, serves: mode, id: model.id)
        guard builder.isPresent(model) else {
            throw FluidServerSTTError.loadFailed(
                id: model.id, detail: "its weights are not on this machine")
        }
        let variant: RosterVariant?
        do {
            // A model with variants needs the request's parameters to pick one.
            variant = try model.resolve(variant: nil, params: params)
        } catch let error as RosterError {
            throw FluidServerSTTError.roster(error)
        }
        return (model, mode, variant)
    }

    private static func check(kind: ModelKind, serves mode: LoadMode, id: String) throws {
        if mode == .batch, !kind.servesBatch {
            throw FluidServerSTTError.streamingModelSelected(id)
        }
        if mode == .streaming, !kind.servesStreaming {
            throw FluidServerSTTError.notStreamable(id)
        }
    }

    /// Run `work` as the in-flight load for `id`. The record is cleared by the
    /// task itself before its value resolves, so a waiter never sees a
    /// finished load still in flight.
    ///
    /// A load that succeeds counts as work in the same step, so an idle check
    /// can never see the fresh model with a clock left over from before it.
    private func track(
        id: String, kind: InFlightKind, _ work: @escaping @Sendable () async throws -> String
    ) async throws -> String {
        inFlightSeq += 1
        let seq = inFlightSeq
        let task = Task<String, Error> {
            do {
                let result = try await work()
                if kind != .unload { self.lastWork = .now }
                self.clearInFlight(seq)
                return result
            } catch {
                self.clearInFlight(seq)
                throw error
            }
        }
        inFlight = (seq, id, kind, task)
        return try await task.value
    }

    /// Give a build failure the server's own error, so a route reports which
    /// model failed and why instead of a bare 500.
    private static func asLoadFailure<T: Sendable>(
        id: String, _ build: @Sendable () async throws -> T
    ) async throws -> T {
        do {
            return try await build()
        } catch let error as FluidServerSTTError {
            throw error
        } catch let error as SlotError {
            throw error
        } catch {
            throw FluidServerSTTError.loadFailed(id: id, detail: String(describing: error))
        }
    }

    private func clearInFlight(_ seq: UInt64) {
        if inFlight?.seq == seq { inFlight = nil }
    }

    /// Which variant of the resident model is loaded, nil for one with only
    /// its implicit variant.
    var loadedVariant: String? {
        get async { await slot.loadedVariant }
    }

    /// Transcribe on the resident model, loading into an empty slot first.
    ///
    /// `expecting` names the model the caller wants. Another model resident is
    /// a mismatch, never a switch: a switch would make the caller pay load time
    /// inside a transcription, contaminating every timing figure from that run.
    func transcribe(url: URL, expecting: String?) async throws -> TranscriptionOutput {
        try await ensure(named: expecting, mode: .batch)
        defer { lastWork = .now }
        return try await slot.withModel(.batch) { model in
            // Whether a batch path exists, not whether a session does: a model
            // holding both modes has a session *and* a one-shot call, and
            // asking about the session would refuse the transcription it can
            // perfectly well serve.
            // An explicit load can land between `ensure` and taking the slot.
            try self.checkExpected(expecting, loaded: model.id)
            guard model.modes.contains(.batch) else {
                throw FluidServerSTTError.streamingModelSelected(model.id)
            }
            return try await model.transcribe(url: url)
        }
    }

    // MARK: - Streaming

    /// Take the resident session for the life of a connection.
    ///
    /// `expecting` names the model the caller wants, as on the transcription
    /// endpoint: an empty slot loads it (or the roster default when nil), and
    /// another model resident is a mismatch, so opening a socket never evicts
    /// a model from under another caller.
    ///
    /// Who gets the slot is the claim's decision, by `session` id: nobody
    /// holding it, or the holder's own id reconnecting, grants it; another id
    /// is refused `held` unless `takeover` is set, in which case the holder is
    /// displaced. `onDisplaced` tells the connection that held it before —
    /// `.replaced` for its own reconnect, `.takenOver` for someone else's.
    ///
    /// Every session starts from a clean decoder: a displaced connection never
    /// reaches the reset its own exit would perform.
    ///
    /// The model is checked before the claim, so a connection that will be
    /// refused cannot take the claim on its way out. It is checked again after,
    /// against the model the slot actually handed over: a load can land
    /// between the two.
    ///
    /// The connection owns the claim and the slot until `endSession` runs or it
    /// is displaced. Every caller must pair this with that release on every
    /// path out.
    @discardableResult
    func beginSession(
        expecting: String?, params: [ParamBinding] = [], session: String?, takeover: Bool = false,
        onDisplaced: @escaping @Sendable (DisplacedReason) async -> Void = { _ in }
    ) async throws -> (token: UInt64, claim: ClaimToken, id: String) {
        try await ensure(named: expecting, mode: .streaming, params: params)
        lastWork = .now
        let claimed = try await claim.claim(
            session: session, takeover: takeover, onDisplaced: onDisplaced)
        do {
            let begun = try await slot.beginWork(.session, supersedable: true)
            do {
                let currentId = begun.model.id
                try checkExpected(expecting, loaded: currentId)
                if let expecting, !params.isEmpty {
                    try checkTier(named: expecting, params: params, loaded: await slot.loadedVariant)
                }
                guard begun.model.session != nil else {
                    // Streaming-capable but not resident that way is a different
                    // condition from a model that cannot stream at all, and the
                    // remedy differs: load the mode, versus pick another model.
                    if let m = roster.model(id: currentId), m.kind.servesStreaming {
                        throw FluidServerSTTError.modeNotLoaded(
                            id: currentId, mode: LoadMode.streaming.rawValue)
                    }
                    throw FluidServerSTTError.notStreamable(currentId)
                }
                try await withSession(token: begun.token) { try await $0.reset() }
                logger.info("session \(begun.token) streaming on \(currentId)")
                return (begun.token, claimed, currentId)
            } catch {
                await slot.end(token: begun.token)
                throw error
            }
        } catch {
            await claim.release(token: claimed)
            throw error
        }
    }

    func appendToSession(token: UInt64, samples: [Float]) async throws -> String {
        lastWork = .now
        return try await withSession(token: token) { session in
            try await session.append(samples: samples)
            return await session.partial()
        }
    }

    func finishSession(token: UInt64) async throws -> (text: String, words: [WordTiming]) {
        lastWork = .now
        return try await withSession(token: token) { try await $0.finish() }
    }

    /// Ready the session for the next utterance, keeping it open.
    ///
    /// This is what lets one connection carry a whole conversation: `finish`
    /// returns the transcript, this readies the manager for the next turn, and
    /// the model stays loaded between them.
    func resetSession(token: UInt64) async throws {
        lastWork = .now
        try await withSession(token: token) { try await $0.reset() }
    }

    /// Release the connection `token` and `claim` identify. Safe to call when
    /// neither is active or when a later connection has displaced them, so it
    /// can sit on every path out of a connection.
    ///
    /// The weights are *not* unloaded: the session is the resident model, and
    /// outlives the socket as a batch manager outlives a transcription. Its
    /// decoder state does not. A connection that ends without `Finalize` — a
    /// closed tab, a dropped socket, a decode failure — never reaches the reset
    /// that a finished utterance performs, and the accumulated transcript would
    /// then be waiting in the manager for whoever connects next. Resetting here
    /// makes every exit leave the session as clean as the finalizing one does.
    ///
    /// The reset runs before the slot is released, and only while `token`
    /// still holds it, so a displaced connection cannot clear the state of the
    /// one that replaced it. A failure to reset is logged and the slot released
    /// anyway: holding it would wedge the server for every later caller.
    ///
    /// Returns false when a newer connection had already taken the session
    /// over, so the caller can say that is why this one ended.
    @discardableResult
    func endSession(token: UInt64, claim claimToken: ClaimToken) async -> Bool {
        lastWork = .now
        var stillHeld = true
        do {
            try await withSession(token: token) { try await $0.reset() }
        } catch SlotError.superseded {
            stillHeld = false
        } catch {
            logger.warning("session \(token) reset on disconnect failed: \(error)")
        }
        await slot.end(token: token)
        await claim.release(token: claimToken)
        return stillHeld
    }

    /// Drop `id` if it is the resident model. Unloading something else is a
    /// no-op rather than an error: the caller's intent is "this is not needed",
    /// and it is already true.
    func unload(id: String) async throws {
        guard roster.model(id: id) != nil else {
            throw FluidServerSTTError.unknownModel(id)
        }
        // Through the in-flight record, so it never empties the slot under a
        // load or mode addition that a request is waiting on.
        while let pending = inFlight { _ = try? await pending.task.value }
        _ = try await track(id: id, kind: .explicit) { [slot] in
            guard await slot.loadedId == id else { return id }
            try await slot.unload()
            return id
        }
    }

    /// Refuse a caller whose `expecting` names a model other than `loaded`:
    /// unknown to the roster, or known but not the resident one. Nil
    /// `expecting` asserts nothing.
    private nonisolated func checkExpected(_ expecting: String?, loaded: String?) throws {
        guard let want = expecting, want != loaded else { return }
        guard roster.model(id: want) != nil else {
            throw FluidServerSTTError.unknownModel(want)
        }
        throw FluidServerSTTError.modelMismatch(requested: want, loaded: loaded ?? "none")
    }

    /// Run `body` against the live session `token` holds, or say why it
    /// cannot: the session was taken over, or there is none.
    private func withSession<T: Sendable>(
        token: UInt64, _ body: @Sendable (StreamingSession) async throws -> T
    ) async throws -> T {
        try await slot.withWork(token: token) { model in
            guard let session = model.session else { throw SlotError.empty }
            return try await body(session)
        }
    }
}
