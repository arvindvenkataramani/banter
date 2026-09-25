import FluidAudio
import FluidServerKit
import Foundation
import Logging

/// The STT server's view of the one resident model.
///
/// The lifecycle — one model at a time, one operation at a time, a token that
/// releases the work that took the slot — is `ResidentSlot` in the kit, and the
/// reasoning lives there. What is here is what transcription adds: the manager
/// shapes, and the rule that a model is never switched out from under a caller.
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

    init(roster: Roster, logger: Logger, waitDeadline: Duration = .seconds(2)) {
        self.roster = roster
        self.logger = logger
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

        if await slot.loadedId == id, await slot.loadedVariant == variant?.id,
            let current = await slot.currentModel
        {
            if let extended = try await current.adding(mode: mode) {
                await slot.replaceInPlace(id: id, model: extended)
                logger.info("added \(mode.rawValue) to resident \(id)")
            }
            return variant?.id
        }

        try await slot.load(id: id, variant: variant?.id) {
            try await LoadedModel.load(model, mode: mode, variant: variant)
        }
        return variant?.id
    }

    /// Which variant of the resident model is loaded, nil for one with only
    /// its implicit variant.
    var loadedVariant: String? {
        get async { await slot.loadedVariant }
    }

    /// Transcribe on the resident model.
    ///
    /// `expecting` names the model the caller believes is loaded. A mismatch
    /// fails rather than switching: a silent switch would make the caller pay
    /// load time inside a transcription, contaminating every timing figure from
    /// that run.
    func transcribe(url: URL, expecting: String?) async throws -> TranscriptionOutput {
        try checkExpected(expecting, loaded: await slot.loadedId)
        return try await slot.withModel(.batch) { model in
            // Whether a batch path exists, not whether a session does: a model
            // holding both modes has a session *and* a one-shot call, and
            // asking about the session would refuse the transcription it can
            // perfectly well serve.
            guard model.modes.contains(.batch) else {
                throw FluidServerSTTError.streamingModelSelected(model.id)
            }
            return try await model.transcribe(url: url)
        }
    }

    // MARK: - Streaming

    /// Take the resident session for the life of a connection.
    ///
    /// `expecting` asserts which model the caller believes is loaded, exactly as
    /// it does on the transcription endpoint — it never switches. Loading is
    /// `/v1/models/load` and nothing else, so opening a socket cannot evict a
    /// model out from under another caller, and cannot pay a load cost the
    /// caller did not ask for.
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
        expecting: String?, session: String?, takeover: Bool = false,
        onDisplaced: @escaping @Sendable (DisplacedReason) async -> Void = { _ in }
    ) async throws -> (token: UInt64, claim: ClaimToken, id: String) {
        try checkExpected(expecting, loaded: await slot.loadedId)
        let claimed = try await claim.claim(
            session: session, takeover: takeover, onDisplaced: onDisplaced)
        do {
            let begun = try await slot.beginWork(.session, supersedable: true)
            do {
                let currentId = begun.model.id
                try checkExpected(expecting, loaded: currentId)
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
        try await withSession(token: token) { session in
            try await session.append(samples: samples)
            return await session.partial()
        }
    }

    func finishSession(token: UInt64) async throws -> (text: String, words: [WordTiming]) {
        try await withSession(token: token) { try await $0.finish() }
    }

    /// Ready the session for the next utterance, keeping it open.
    ///
    /// This is what lets one connection carry a whole conversation: `finish`
    /// returns the transcript, this readies the manager for the next turn, and
    /// the model stays loaded between them.
    func resetSession(token: UInt64) async throws {
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
        guard await slot.loadedId == id else { return }
        try await slot.unload()
    }

    /// Refuse a caller whose `expecting` names a model other than `loaded`:
    /// unknown to the roster, or known but not the resident one. Nil
    /// `expecting` asserts nothing.
    private func checkExpected(_ expecting: String?, loaded: String?) throws {
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
