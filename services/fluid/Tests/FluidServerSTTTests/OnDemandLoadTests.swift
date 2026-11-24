import FluidAudio
import FluidServerKit
import Logging
import XCTest

@testable import FluidServerSTT

/// A request loads its model into an empty slot, replaces an idle resident one
/// once the work in flight ends, and is refused at once while a session holds
/// the server; the model is unloaded after an idle interval.
///
/// Models are built by a stand-in builder: managers constructed without their
/// weights, which is enough to occupy the slot, report modes and reset a
/// session. A gate lets a test hold a load open while other requests arrive.
final class OnDemandLoadTests: XCTestCase {
    private struct LoadFailed: Error {}

    /// Opens once; every waiter before and after proceeds.
    private actor Gate {
        private var open = false
        private var waiters: [CheckedContinuation<Void, Never>] = []
        func wait() async {
            if open { return }
            await withCheckedContinuation { waiters.append($0) }
        }
        func release() {
            open = true
            waiters.forEach { $0.resume() }
            waiters.removeAll()
        }
    }

    /// Records why the connection holding the session was displaced, if it was.
    private actor DisplacedLog {
        private(set) var reasons: [DisplacedReason] = []
        func record(_ reason: DisplacedReason) { reasons.append(reason) }
    }

    /// Counts builder calls, so a test can tell one load from two.
    private actor Calls {
        private(set) var loads = 0
        private(set) var adds = 0
        func loaded() { loads += 1 }
        func added() { adds += 1 }
    }

    private static func standIn(_ model: ValidatedModel, _ mode: LoadMode, _ variant: RosterVariant?)
        -> LoadedModel
    {
        switch model.family {
        case .batchTdt:
            return .batchTdt(id: model.id, manager: AsrManager(), decoderLayerCount: 2)
        case .unified:
            return .unified(
                id: model.id,
                offline: mode == .streaming ? nil : UnifiedAsrManager(),
                streaming: mode == .batch ? nil : StreamingUnifiedAsrManager())
        case .nemotron:
            return .nemotron(
                id: model.id, manager: StreamingNemotronAsrManager(requestedChunkSize: .ms1120),
                chunkMs: 1120)
        }
    }

    private func builder(
        calls: Calls, gate: Gate? = nil, fails: Bool = false, present: Bool = true
    ) -> ModelBuilder {
        ModelBuilder(
            load: { model, mode, variant in
                await calls.loaded()
                if let gate { await gate.wait() }
                if fails { throw LoadFailed() }
                return Self.standIn(model, mode, variant)
            },
            addMode: { current, mode in
                await calls.added()
                guard case .unified(let id, let offline, let streaming) = current else { return nil }
                return .unified(
                    id: id,
                    offline: offline ?? (mode == .streaming ? nil : UnifiedAsrManager()),
                    streaming: streaming ?? (mode == .batch ? nil : StreamingUnifiedAsrManager()))
            },
            isPresent: { _ in present })
    }

    private func roster(defaultModel: String? = "unified") throws -> Roster {
        let tiers = [560, 1120].map {
            RosterVariant(id: "\($0)ms", params: [ParamBinding(name: "chunkMs", value: $0)])
        }
        return try Roster.validate(
            [
                RosterEntry(
                    id: "unified", name: "Unified", key: "parakeet-unified-0.6b", kind: .both,
                    params: nil, variants: nil),
                RosterEntry(
                    id: "tdt", name: "TDT", key: "parakeet-tdt-v3", kind: .batch,
                    params: nil, variants: nil),
                RosterEntry(
                    id: "nemotron", name: "Nemotron", key: "nemotron-streaming-en-0.6b",
                    kind: .streaming,
                    params: [RosterParam(name: "chunkMs", values: [560, 1120])], variants: tiers),
            ], defaultModel: defaultModel)
    }

    private func makeResident(
        calls: Calls, gate: Gate? = nil, fails: Bool = false, present: Bool = true,
        defaultModel: String? = "unified", waitDeadline: Duration = .seconds(2)
    ) throws -> ResidentModel {
        ResidentModel(
            roster: try roster(defaultModel: defaultModel), logger: Logger(label: "test"),
            waitDeadline: waitDeadline,
            builder: builder(calls: calls, gate: gate, fails: fails, present: present))
    }

    /// Waits until the builder has been entered `count` times, so a test knows
    /// a load is in flight before it sends the next request.
    private func waitForLoads(_ calls: Calls, _ count: Int) async throws {
        for _ in 0..<400 {
            if await calls.loads >= count { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("the builder was never entered \(count) time(s)")
    }

    // MARK: - Loading into the slot

    func testANamelessBatchRequestIntoAnEmptySlotLoadsTheDefaultInBatchMode() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)

        let served = try await resident.ensure(named: nil, mode: .batch)

        XCTAssertEqual(served, "unified")
        let loaded = await resident.loadedId
        let modes = await resident.residentModes
        XCTAssertEqual(loaded, "unified")
        XCTAssertEqual(modes, ["batch"])
    }

    func testAStreamingSessionNamingAModelIntoAnEmptySlotLoadsItInStreamingMode() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)

        let session = try await resident.beginSession(expecting: "unified", session: "a")

        XCTAssertEqual(session.id, "unified")
        let modes = await resident.residentModes
        XCTAssertEqual(modes, ["streaming"])
        await resident.endSession(token: session.token, claim: session.claim)
    }

    func testS1_ANamedRequestForAnotherModelReplacesTheIdleResidentModel() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: "tdt", mode: .batch)

        let served = try await resident.ensure(named: "unified", mode: .batch)

        XCTAssertEqual(served, "unified")
        let loaded = await resident.loadedId
        let loads = await calls.loads
        XCTAssertEqual(loaded, "unified")
        XCTAssertEqual(loads, 2)
    }

    /// A variant is a different model for this rule (spec section 9).
    func testS1_ARequestNamingAnotherVariantOfTheIdleResidentModelReplacesIt() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(
            named: "nemotron", mode: .streaming, params: [ParamBinding(name: "chunkMs", value: 1120)])

        try await resident.ensure(
            named: "nemotron", mode: .streaming, params: [ParamBinding(name: "chunkMs", value: 560)])

        let loads = await calls.loads
        XCTAssertEqual(loads, 2)
    }

    /// Requests run one at a time, so the replacing load starts only after the
    /// work already in flight has finished.
    func testS1_AReplacementStartsOnlyAfterTheWorkInFlightEnds() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: "tdt", mode: .batch)
        let work = Task { try await resident.slot.withModel(.batch) { _ in await gate.wait() } }
        try await Task.sleep(for: .milliseconds(50))

        let replacing = Task { try await resident.ensure(named: "unified", mode: .batch) }
        try await Task.sleep(for: .milliseconds(200))
        let during = await resident.loadedId
        let loadsDuring = await calls.loads
        XCTAssertEqual(during, "tdt", "the model in use must not be replaced under its work")
        XCTAssertEqual(loadsDuring, 1)

        await gate.release()
        try await work.value
        let served = try await replacing.value
        XCTAssertEqual(served, "unified")
        let loaded = await resident.loadedId
        XCTAssertEqual(loaded, "unified")
    }

    /// Refused at once, whatever the request names: what is asserted is that it
    /// fails fast, builds nothing, and leaves the holder and its model alone.
    func testS1_ARequestNamingAnotherModelIsRefusedAtOnceWhileASessionHoldsTheServer() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        let told = DisplacedLog()
        let live = try await resident.beginSession(
            expecting: "unified", session: "a", onDisplaced: { await told.record($0) })

        let started = ContinuousClock.now
        do {
            try await resident.ensure(named: "tdt", mode: .batch)
            XCTFail("a request must not displace the model a session is using")
        } catch {}
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(1), "refused at once, not after the deadline")

        let loads = await calls.loads
        let loaded = await resident.loadedId
        let reasons = await told.reasons
        XCTAssertEqual(loads, 1, "nothing is built for a refused request")
        XCTAssertEqual(loaded, "unified")
        XCTAssertTrue(reasons.isEmpty, "the holder is not displaced")
        let stillHeld = await resident.endSession(token: live.token, claim: live.claim)
        XCTAssertTrue(stillHeld)
    }

    func testANamelessRequestUsesTheResidentModelRatherThanLoadingTheDefault() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: "tdt", mode: .batch)

        let served = try await resident.ensure(named: nil, mode: .batch)

        XCTAssertEqual(served, "tdt")
        let loads = await calls.loads
        XCTAssertEqual(loads, 1)
    }

    func testARequestNeedingTheOtherModeOfABothModeModelAddsItWithoutReloading() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: "unified", mode: .streaming)

        try await resident.ensure(named: nil, mode: .batch)

        let loads = await calls.loads
        let adds = await calls.adds
        let modes = Set(await resident.residentModes)
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(adds, 1)
        XCTAssertEqual(modes, ["batch", "streaming"])
    }

    func testABatchRequestWhileAStreamingOnlyModelIsResidentIsRefusedAndNothingLoads() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.slot.load(id: "nemotron", variant: "1120ms") {
            .nemotron(
                id: "nemotron", manager: StreamingNemotronAsrManager(requestedChunkSize: .ms1120),
                chunkMs: 1120)
        }

        do {
            try await resident.ensure(named: nil, mode: .batch)
            XCTFail("a streaming-only model cannot serve a batch request")
        } catch FluidServerSTTError.streamingModelSelected(let id) {
            XCTAssertEqual(id, "nemotron")
        }
        let loaded = await resident.loadedId
        let loads = await calls.loads
        XCTAssertEqual(loaded, "nemotron")
        XCTAssertEqual(loads, 0)
    }

    func testTwoRequestsForTheSameModelDuringOneLoadCauseOneLoadAndBothAreServed() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls, gate: gate)

        let first = Task { try await resident.ensure(named: nil, mode: .batch) }
        try await waitForLoads(calls, 1)
        // The second request arrives while the first load is held open.
        let second = Task { try await resident.ensure(named: "unified", mode: .batch) }
        try await Task.sleep(for: .milliseconds(100))
        await gate.release()

        let a = try await first.value
        let b = try await second.value
        XCTAssertEqual(a, "unified")
        XCTAssertEqual(b, "unified")
        let loads = await calls.loads
        XCTAssertEqual(loads, 1)
    }

    func testARequestWaitsOutALoadLongerThanTheSlotsBusyDeadline() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls, gate: gate, waitDeadline: .milliseconds(50))

        let first = Task { try await resident.ensure(named: nil, mode: .batch) }
        try await waitForLoads(calls, 1)
        let second = Task { try await resident.ensure(named: nil, mode: .batch) }
        // Six times the slot's deadline: waiting on the slot would have failed busy.
        try await Task.sleep(for: .milliseconds(300))
        await gate.release()

        let a = try await first.value
        let b = try await second.value
        XCTAssertEqual(a, "unified")
        XCTAssertEqual(b, "unified")
    }

    func testAModeAdditionIsRefusedBusyWithoutBuildingWhileASessionHoldsTheSlot() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        let session = try await resident.beginSession(expecting: "unified", session: "a")

        do {
            try await resident.ensure(named: nil, mode: .batch)
            XCTFail("adding a mode under a live session should be refused")
        } catch SlotError.busy {}

        let adds = await calls.adds
        XCTAssertEqual(adds, 0, "the encoder should not be built when the slot is held")
        await resident.endSession(token: session.token, claim: session.claim)
    }

    func testS1_ASecondRequestNamingAnotherModelDuringALoadWaitsForItThenReplacesIt() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls, gate: gate)

        let first = Task { try await resident.ensure(named: "unified", mode: .batch) }
        try await waitForLoads(calls, 1)
        let second = Task { try await resident.ensure(named: "tdt", mode: .batch) }
        try await Task.sleep(for: .milliseconds(100))
        await gate.release()

        let servedFirst = try await first.value
        let servedSecond = try await second.value
        XCTAssertEqual(servedFirst, "unified")
        XCTAssertEqual(servedSecond, "tdt")
        let loaded = await resident.loadedId
        let loads = await calls.loads
        XCTAssertEqual(loaded, "tdt")
        XCTAssertEqual(loads, 2)
    }

    func testTheSlotsLoadIfEmptyNeverReplacesAResidentModel() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: "tdt", mode: .batch)

        let after = try await resident.slot.loadIfEmpty(id: "unified") {
            .unified(id: "unified", offline: UnifiedAsrManager(), streaming: nil)
        }

        XCTAssertEqual(after, "tdt")
        let loaded = await resident.loadedId
        XCTAssertEqual(loaded, "tdt")
    }

    func testAFailedLoadFailsEveryRequestWaitingOnItAndLeavesTheSlotEmpty() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls, gate: gate, fails: true)

        let first = Task { try await resident.ensure(named: nil, mode: .batch) }
        try await waitForLoads(calls, 1)
        let second = Task { try await resident.ensure(named: nil, mode: .batch) }
        try await Task.sleep(for: .milliseconds(50))
        await gate.release()

        for request in [first, second] {
            do {
                _ = try await request.value
                XCTFail("a request waiting on a failed load should fail")
            } catch FluidServerSTTError.loadFailed(let id, _) {
                XCTAssertEqual(id, "unified")
            }
        }
        let loaded = await resident.loadedId
        let loads = await calls.loads
        XCTAssertNil(loaded)
        XCTAssertEqual(loads, 1)
    }

    func testARequestNamingAModelThatNeedsAParameterIsRefusedAndNothingLoads() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)

        do {
            try await resident.ensure(named: "nemotron", mode: .streaming)
            XCTFail("a model that needs a parameter is loaded only explicitly")
        } catch FluidServerSTTError.roster(.variantRequired(let id, _)) {
            XCTAssertEqual(id, "nemotron")
        }
        let loaded = await resident.loadedId
        let loads = await calls.loads
        XCTAssertNil(loaded)
        XCTAssertEqual(loads, 0)
    }

    func testANamelessRequestIntoAnEmptySlotWithNoDefaultIsRefused() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls, defaultModel: nil)

        do {
            try await resident.ensure(named: nil, mode: .batch)
            XCTFail("with no default, a nameless request has nothing to load")
        } catch FluidServerSTTError.noModelLoaded {}
        let loads = await calls.loads
        XCTAssertEqual(loads, 0)
    }

    // MARK: - Sessions occupy the service; other work queues

    func testWorkBehindASessionIsRefusedAtOnce() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        let session = try await resident.beginSession(expecting: nil, session: "a")

        let started = ContinuousClock.now
        do {
            try await resident.slot.withModel(.batch) { _ in }
            XCTFail("batch work should not run while a session holds the service")
        } catch SlotError.busy(let work) {
            XCTAssertEqual(work, .session)
        }
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(1), "refused at once, not after the deadline")
        await resident.endSession(token: session.token, claim: session.claim)
    }

    func testBatchWorkQueuesBehindOtherBatchWorkAndRunsWhenItEnds() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: nil, mode: .batch)

        let first = Task { try await resident.slot.withModel(.batch) { _ in await gate.wait() } }
        try await Task.sleep(for: .milliseconds(50))
        let second = Task { try await resident.slot.withModel(.batch) { _ in "ran" } }
        try await Task.sleep(for: .milliseconds(200))
        await gate.release()

        try await first.value
        let result = try await second.value
        XCTAssertEqual(result, "ran")
    }

    func testASessionCarryingATierLoadsAModelThatNeedsOne() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)

        let session = try await resident.beginSession(
            expecting: "nemotron", params: [ParamBinding(name: "chunkMs", value: 1120)], session: "a")

        XCTAssertEqual(session.id, "nemotron")
        let variant = await resident.loadedVariant
        XCTAssertEqual(variant, "1120ms")
        await resident.endSession(token: session.token, claim: session.claim)
    }

    func testAnExplicitLoadOfAnotherModelDuringASessionIsRefusedAtOnce() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        let session = try await resident.beginSession(expecting: nil, session: "a")

        do {
            try await resident.load(id: "tdt", mode: nil, variant: nil, params: [])
            XCTFail("a load that would change the model must not displace a session")
        } catch SlotError.busy(let work) {
            XCTAssertEqual(work, .session)
        }
        let loaded = await resident.loadedId
        XCTAssertEqual(loaded, "unified")
        await resident.endSession(token: session.token, claim: session.claim)
    }

    func testAnExplicitLoadAlreadySatisfiedDuringASessionSucceedsWithoutChange() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        let session = try await resident.beginSession(expecting: "unified", session: "a")

        try await resident.load(id: "unified", mode: .streaming, variant: nil, params: [])

        let loads = await calls.loads
        let adds = await calls.adds
        XCTAssertEqual(loads, 1)
        XCTAssertEqual(adds, 0)
        await resident.endSession(token: session.token, claim: session.claim)
    }

    func testAModeAdditionBehindBatchWorkQueuesAndCompletes() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: nil, mode: .batch)

        let batch = Task { try await resident.slot.withModel(.batch) { _ in await gate.wait() } }
        try await Task.sleep(for: .milliseconds(50))
        let streaming = Task { try await resident.ensure(named: nil, mode: .streaming) }
        try await Task.sleep(for: .milliseconds(200))
        await gate.release()

        try await batch.value
        _ = try await streaming.value
        let modes = Set(await resident.residentModes)
        XCTAssertEqual(modes, ["batch", "streaming"])
    }

    func testARequestNeverLoadsAModelWhoseWeightsAreNotOnThisMachine() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls, present: false)

        do {
            try await resident.ensure(named: nil, mode: .batch)
            XCTFail("loading absent weights would download them")
        } catch FluidServerSTTError.loadFailed(let id, _) {
            XCTAssertEqual(id, "unified")
        }
        let loads = await calls.loads
        XCTAssertEqual(loads, 0)
    }

    func testACancelledWaiterStopsWaitingAtOnce() async throws {
        let calls = Calls()
        let gate = Gate()
        let resident = try makeResident(calls: calls, waitDeadline: .seconds(120))
        try await resident.ensure(named: nil, mode: .batch)
        let batch = Task { try await resident.slot.withModel(.batch) { _ in await gate.wait() } }
        try await Task.sleep(for: .milliseconds(50))

        let waiter = Task { try await resident.slot.withModel(.batch) { _ in "ran" } }
        try await Task.sleep(for: .milliseconds(50))
        let started = ContinuousClock.now
        waiter.cancel()
        do {
            _ = try await waiter.value
            XCTFail("a cancelled waiter should not run")
        } catch is CancellationError {}
        XCTAssertLessThan(ContinuousClock.now - started, .seconds(1))
        await gate.release()
        try await batch.value
    }

    func testARequestForATierTheModelDoesNotOfferIsRefused() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(
            named: "nemotron", mode: .streaming, params: [ParamBinding(name: "chunkMs", value: 1120)])

        do {
            try await resident.ensure(
                named: "nemotron", mode: .streaming, params: [ParamBinding(name: "chunkMs", value: 999)])
            XCTFail("an unoffered tier should be refused, not served by the resident one")
        } catch FluidServerSTTError.roster {}
    }

    // MARK: - Idle unload

    func testTheModelUnloadsOnceTheIdleIntervalPassesWithNoWorkAndNotBefore() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: nil, mode: .batch)

        let early = await resident.unloadIfIdle(after: .milliseconds(300))
        XCTAssertFalse(early)
        let stillLoaded = await resident.loadedId
        XCTAssertEqual(stillLoaded, "unified")

        try await Task.sleep(for: .milliseconds(400))
        let late = await resident.unloadIfIdle(after: .milliseconds(300))
        XCTAssertTrue(late)
        let loaded = await resident.loadedId
        XCTAssertNil(loaded)
    }

    func testHealthChecksAndModelListingsDoNotResetTheIdleClock() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: nil, mode: .batch)

        // What /healthz and GET /v1/models read, polled through the interval.
        for _ in 0..<4 {
            try await Task.sleep(for: .milliseconds(50))
            _ = await resident.loadedId
            _ = await resident.loadedVariant
            _ = await resident.residentModes
        }
        let unloaded = await resident.unloadIfIdle(after: .milliseconds(150))
        XCTAssertTrue(unloaded)
    }

    func testASessionHoldingTheSlotPastTheIdleIntervalKeepsItsModel() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        let session = try await resident.beginSession(expecting: nil, session: "a")

        try await Task.sleep(for: .milliseconds(200))
        let unloaded = await resident.unloadIfIdle(after: .milliseconds(50))

        XCTAssertFalse(unloaded)
        let loaded = await resident.loadedId
        XCTAssertEqual(loaded, "unified")
        await resident.endSession(token: session.token, claim: session.claim)
    }

    func testARequestAfterAnIdleUnloadLoadsTheModelAgain() async throws {
        let calls = Calls()
        let resident = try makeResident(calls: calls)
        try await resident.ensure(named: nil, mode: .batch)
        try await Task.sleep(for: .milliseconds(100))
        let unloaded = await resident.unloadIfIdle(after: .milliseconds(50))
        XCTAssertTrue(unloaded)

        let served = try await resident.ensure(named: nil, mode: .batch)

        XCTAssertEqual(served, "unified")
        let loads = await calls.loads
        XCTAssertEqual(loads, 2)
    }
}
