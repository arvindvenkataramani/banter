import Foundation
import Logging

/// Which kind of work holds the slot. A caller that is refused learns what it
/// is waiting behind, which is the difference between a useful log line and
/// "busy".
public enum SlotWork: String, Sendable {
    case batch
    case stream
    case session
}

public enum SlotError: Error, CustomStringConvertible, Sendable {
    case busy(SlotWork)
    case empty
    case superseded

    public var description: String {
        switch self {
        case .busy(let work):
            return "the model is busy with a \(work.rawValue) request; one runs at a time"
        case .empty:
            return "no model is loaded"
        case .superseded:
            return "a newer connection took over this session"
        }
    }
}

/// One model resident at a time, and one operation running against it.
///
/// CoreML is not reentrant, and FluidAudio relies on per-manager actor
/// isolation for safety — their issue #661 reports `EXC_BAD_ACCESS` in libBNNS
/// when two managers predict concurrently. Actor isolation alone is enough only
/// while every call awaits its own completion inside the actor. It stops being
/// enough the moment an operation outlives the call that started it: a
/// streaming synthesis returns its stream immediately and keeps predicting, and
/// a transcription session lives for as long as a socket is open. Either way a
/// second caller can arrive mid-generation and put two predictions in flight.
///
/// So the slot is explicit. It is taken for the whole span of the work, and
/// released by whoever took it — for a long-running operation, when the work
/// actually ends, not when its caller walks away.
///
/// Generic over what it holds so both servers use one implementation; the work
/// methods stay modality-specific and live in the servers.
public actor ResidentSlot<Model: Sendable> {
    /// The loaded model and the id and variant it answers to.
    private var loaded: (id: String, variant: String?, model: Model)?
    /// The live operation, if any. A supersedable one gives way to a newcomer
    /// of the same kind, and `onSuperseded` tells its owner.
    private var active:
        (
            token: UInt64, work: SlotWork, supersedable: Bool,
            onSuperseded: (@Sendable () async -> Void)?
        )?
    /// Calls running under the active token through `withWork`. A takeover
    /// waits for these, so the old owner's last prediction finishes before the
    /// new owner's first begins.
    private var inFlight = 0
    /// True for the whole span of a load or unload, including across the
    /// `await` that performs it. `loaded` and `active` are both nil during part
    /// of that span and so cannot alone signal the actor is working.
    private var transitioning = false
    /// Distinguishes one operation from the next, so a late release cannot end
    /// the one that replaced it.
    private var counter: UInt64 = 0
    private let waitDeadline: Duration
    private let logger: Logger
    /// Called when a model leaves the slot, so the owner can tear down whatever
    /// the model holds. Loading a second model unloads the first: holding both
    /// at once is the peak this exists to avoid.
    private let release: @Sendable (String, Model) async -> Void

    /// `waitDeadline` has to outlast the longest single operation, because a
    /// caller queueing behind one is ordinary rather than exceptional: several
    /// chunks of one reply arrive together. A slot still held after it is one
    /// in use, not one that is leaving.
    public init(
        waitDeadline: Duration = .seconds(30),
        logger: Logger,
        release: @escaping @Sendable (String, Model) async -> Void = { _, _ in }
    ) {
        self.waitDeadline = waitDeadline
        self.logger = logger
        self.release = release
    }

    public var loadedId: String? { loaded?.id }
    public var loadedVariant: String? { loaded?.variant }
    /// The resident model, for a caller that needs it outside a `withModel`
    /// body — driving a session it already holds the slot for, say.
    public var currentModel: Model? { loaded?.model }

    /// Swap what is held for `id` without an unload.
    ///
    /// For growing a resident model rather than replacing it: a model whose
    /// components load separately can gain one while the rest stay up, and
    /// going through `load` would release everything first and pay the whole
    /// cost again. The caller has already built the replacement, so this is a
    /// pointer swap and not a load — but it still waits for a free slot,
    /// because exchanging the model under work in flight is the race `load`
    /// avoids for the same reason.
    ///
    /// Refuses when `id` is not what is resident: growing something that has
    /// since been replaced would resurrect it.
    public func replaceInPlace(id: String, model: Model) async {
        guard loaded?.id == id else { return }
        do {
            try await waitForFreeSlot()
        } catch {
            logger.warning("could not take the slot to extend \(id): \(error)")
            return
        }
        guard let current = loaded, current.id == id else { return }
        loaded = (id: id, variant: current.variant, model: model)
    }
    public var isBusy: Bool { active != nil || transitioning }
    public var currentWork: SlotWork? { active?.work }

    /// Make `id` the resident model, building it with `make`.
    ///
    /// The already-resident case returns before the busy check, and must: every
    /// request names its model, so checking first would turn routine same-model
    /// contention into a refusal when nothing is being evicted.
    ///
    /// A model is its id and its `variant`: one id can name weights that differ
    /// by a load parameter, and another variant of the resident id replaces it
    /// like any other model rather than being reported as already loaded.
    public func load(
        id: String, variant: String? = nil, make: @Sendable () async throws -> Model
    ) async throws {
        if isResident(id: id, variant: variant) { return }
        // A load would pull the model out from under work in flight, and a
        // second load would race the one already running.
        try await waitForFreeSlot()
        // The wait yields the actor, and a load that ran meanwhile may have
        // made exactly this model.
        if isResident(id: id, variant: variant) { return }

        transitioning = true
        defer { transitioning = false }

        if let current = loaded {
            logger.info(
                "unloading \(Self.name(current.id, current.variant)) before loading \(Self.name(id, variant))")
            await release(current.id, current.model)
            loaded = nil
        }

        let started = Date()
        loaded = (id: id, variant: variant, model: try await make())
        logger.info(
            "loaded \(Self.name(id, variant)) in \(String(format: "%.1f", Date().timeIntervalSince(started)))s")
    }

    private func isResident(id: String, variant: String?) -> Bool {
        guard let current = loaded else { return false }
        return current.id == id && current.variant == variant
    }

    private static func name(_ id: String, _ variant: String?) -> String {
        variant.map { "\(id) (\($0))" } ?? id
    }

    /// Drop the resident model.
    ///
    /// Refuses rather than waiting, unlike every other entry point: an unload
    /// during live work is a caller mistake, and waiting out the deadline
    /// before honouring it would hide the mistake behind a stall.
    public func unload() async throws {
        if let work = active?.work { throw SlotError.busy(work) }
        if transitioning { throw SlotError.busy(.batch) }
        guard let current = loaded else { return }

        transitioning = true
        defer { transitioning = false }

        logger.info("unloaded \(Self.name(current.id, current.variant))")
        await release(current.id, current.model)
        loaded = nil
    }

    /// Run `body` against the resident model, holding the slot for its span.
    ///
    /// For work that completes within the call. Anything that outlives its
    /// caller takes the slot with `begin` and returns it with `end`.
    public func withModel<T: Sendable>(
        _ work: SlotWork = .batch, _ body: @Sendable (Model) async throws -> T
    ) async throws -> T {
        let token = try await begin(work)
        defer { endSync(token: token) }
        guard let current = loaded else { throw SlotError.empty }
        return try await body(current.model)
    }

    /// Take the slot for work that outlives this call, and return the model
    /// alongside the token that releases it.
    ///
    /// Every caller must reach `end` on every path out — including one where
    /// the client has gone but the model is still computing. Releasing when the
    /// consumer leaves rather than when the work finishes would hand the next
    /// request an overlapping prediction, which is the crash the slot prevents.
    ///
    /// `supersedable` work gives way to a later `beginWork` of the same kind
    /// that is itself supersedable: a quiet session is not a client that has
    /// gone, so it keeps the slot until someone else wants it, and the newcomer
    /// takes over rather than being refused. `onSuperseded` runs once the slot
    /// has changed hands, so the owner can close its connection.
    public func beginWork(
        _ work: SlotWork, supersedable: Bool = false,
        onSuperseded: (@Sendable () async -> Void)? = nil
    ) async throws -> (token: UInt64, model: Model) {
        let token: UInt64
        if let current = active, current.supersedable, supersedable, current.work == work {
            token = try await supersede(work: work, onSuperseded: onSuperseded)
        } else {
            token = try await begin(work, supersedable: supersedable, onSuperseded: onSuperseded)
        }
        guard let current = loaded else {
            endSync(token: token)
            throw SlotError.empty
        }
        return (token, current.model)
    }

    /// Run `body` against the resident model on behalf of the work `token`
    /// holds, refusing if that work has been superseded or has ended. For work
    /// that took the slot with `beginWork` and acts on the model over time, so
    /// each act is checked against who holds the slot now.
    public func withWork<T: Sendable>(
        token: UInt64, _ body: @Sendable (Model) async throws -> T
    ) async throws -> T {
        guard active?.token == token else { throw SlotError.superseded }
        guard let current = loaded else { throw SlotError.empty }
        inFlight += 1
        defer { inFlight -= 1 }
        return try await body(current.model)
    }

    private func begin(
        _ work: SlotWork, supersedable: Bool = false,
        onSuperseded: (@Sendable () async -> Void)? = nil
    ) async throws -> UInt64 {
        try await waitForFreeSlot()
        counter += 1
        active = (counter, work, supersedable, onSuperseded)
        return counter
    }

    /// Hand the slot from the supersedable holder to a newcomer.
    ///
    /// The holder's token stops working at once, so none of its work starts
    /// after this begins; work already running is waited for. The slot is
    /// marked transitioning throughout, so nothing else can take it between
    /// the two owners.
    private func supersede(
        work: SlotWork, onSuperseded: (@Sendable () async -> Void)?
    ) async throws -> UInt64 {
        guard let previous = active else {
            return try await begin(work, supersedable: true, onSuperseded: onSuperseded)
        }
        active = nil
        transitioning = true
        defer { transitioning = false }

        let deadline = ContinuousClock.now + waitDeadline
        while inFlight > 0 {
            if ContinuousClock.now >= deadline {
                active = previous
                throw SlotError.busy(previous.work)
            }
            try? await Task.sleep(for: .milliseconds(5))
        }

        counter += 1
        active = (counter, work, true, onSuperseded)
        logger.info("a new \(work.rawValue) superseded the one holding the slot")
        await previous.onSuperseded?()
        return counter
    }

    /// Release the work `token` identifies. Safe to call when none is active or
    /// when a later one has replaced it, so it can sit on every path out.
    public func end(token: UInt64) {
        endSync(token: token)
    }

    private func endSync(token: UInt64) {
        guard let current = active, current.token == token else { return }
        active = nil
    }

    /// Wait for an operation, or an in-flight load, to release the slot.
    ///
    /// Waiting rather than refusing, because a caller queueing behind another
    /// is ordinary use; the deadline is what separates waiting from hanging.
    private func waitForFreeSlot() async throws {
        guard active != nil || transitioning else { return }
        let deadline = ContinuousClock.now + waitDeadline
        while active != nil || transitioning {
            if ContinuousClock.now >= deadline {
                throw SlotError.busy(active?.work ?? .batch)
            }
            // Yielding the actor is what lets the operation already in flight
            // run: it needs this actor to clear `active`/`transitioning`.
            try? await Task.sleep(for: .milliseconds(25))
        }
    }
}
