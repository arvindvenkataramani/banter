import Logging
import XCTest

@testable import FluidServerKit

/// The slot holds one model and one operation against it.
final class ResidentSlotTests: XCTestCase {
    private func slot(
        release: @escaping @Sendable (String, String) async -> Void = { _, _ in }
    ) -> ResidentSlot<String> {
        ResidentSlot(
            waitDeadline: .milliseconds(200), logger: Logger(label: "test"), release: release)
    }

    func testWorkRunsAgainstTheResidentModel() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let seen = try await s.withModel(.batch) { $0 }
        XCTAssertEqual(seen, "model-a")
    }

    /// Long-running work takes the slot and hands back the model it runs
    /// against — a socket driving a session it did not build.
    func testWorkThatOutlivesItsCallerGetsTheResidentModel() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let begun = try await s.beginWork(.session)
        XCTAssertEqual(begun.model, "model-a")
        let held = await s.isBusy
        XCTAssertTrue(held)
        await s.end(token: begun.token)
    }

    /// Nothing loaded is nothing to work against, whichever entry point asks.
    func testWorkWithNothingLoadedIsRefused() async throws {
        let s = slot()
        for attempt in [SlotWork.batch, .session] {
            do {
                _ = try await s.beginWork(attempt)
                XCTFail("\(attempt.rawValue) work ran with nothing loaded")
            } catch let error as SlotError {
                guard case .empty = error else {
                    return XCTFail("expected empty, got \(error)")
                }
            }
        }
    }

    /// Holding the slot excludes everything else, and the refusal names what
    /// holds it — the difference between a useful log line and "busy".
    func testHeldWorkExcludesOtherWork() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let begun = try await s.beginWork(.session)
        do {
            _ = try await s.withModel(.batch) { $0 }
            XCTFail("batch work entered while a session held the slot")
        } catch let error as SlotError {
            guard case .busy(let work) = error else {
                return XCTFail("expected busy, got \(error)")
            }
            XCTAssertEqual(work, .session)
        }
        await s.end(token: begun.token)
    }

    func testTheSlotIsFreeAgainAfterWorkEnds() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let begun = try await s.beginWork(.session)
        await s.end(token: begun.token)
        let busy = await s.isBusy
        XCTAssertFalse(busy)
        let next = try await s.beginWork(.session)
        await s.end(token: next.token)
    }

    /// One model at a time: loading a second releases the first.
    func testLoadingReleasesTheModelItReplaces() async throws {
        let released = Released()
        let s = slot(release: { id, _ in await released.record(id) })
        try await s.load(id: "a") { "model-a" }
        try await s.load(id: "b") { "model-b" }
        let names = await released.names
        XCTAssertEqual(names, ["a"])
        let now = await s.loadedId
        XCTAssertEqual(now, "b")
    }

    /// Loading what is already resident is not a reload: it would evict a warm
    /// model and pay for the same weights twice.
    func testLoadingTheResidentModelDoesNothing() async throws {
        let released = Released()
        let s = slot(release: { id, _ in await released.record(id) })
        try await s.load(id: "a") { "model-a" }
        try await s.load(id: "a") { XCTFail("rebuilt an already-resident model"); return "again" }
        let names = await released.names
        XCTAssertTrue(names.isEmpty)
    }

    /// A model is its id and its variant. Another variant of the resident id is
    /// a different model: it replaces the resident one, rather than being
    /// reported as loaded while the old weights stay up.
    func testLoadingAnotherVariantOfTheResidentIdReplacesIt() async throws {
        let released = Released()
        let s = slot(release: { id, model in await released.record("\(id):\(model)") })
        try await s.load(id: "a", variant: "v1") { "model-a-v1" }
        try await s.load(id: "a", variant: "v2") { "model-a-v2" }
        let names = await released.names
        XCTAssertEqual(names, ["a:model-a-v1"])
        let now = await s.currentModel
        XCTAssertEqual(now, "model-a-v2")
        let variant = await s.loadedVariant
        XCTAssertEqual(variant, "v2")
    }

    func testLoadingTheResidentVariantDoesNothing() async throws {
        let released = Released()
        let s = slot(release: { id, _ in await released.record(id) })
        try await s.load(id: "a", variant: "v1") { "model-a-v1" }
        try await s.load(id: "a", variant: "v1") {
            XCTFail("rebuilt the resident variant"); return "again"
        }
        let names = await released.names
        XCTAssertTrue(names.isEmpty)
    }

    /// Replacing a variant is a load like any other, so it cannot pull the
    /// model out from under live work: it waits, and past the deadline it is
    /// refused with the resident model left as it was.
    func testReplacingAVariantWaitsForLiveWork() async throws {
        let s = slot()
        try await s.load(id: "a", variant: "v1") { "model-a-v1" }
        let begun = try await s.beginWork(.session)
        do {
            try await s.load(id: "a", variant: "v2") { "model-a-v2" }
            XCTFail("replaced the model under a live session")
        } catch let error as SlotError {
            guard case .busy(let work) = error else {
                return XCTFail("expected busy, got \(error)")
            }
            XCTAssertEqual(work, .session)
        }
        let now = await s.currentModel
        XCTAssertEqual(now, "model-a-v1")
        await s.end(token: begun.token)
    }

    // MARK: - Supersession

    /// A session left quiet is not a client that has gone, so it holds the
    /// slot until someone else wants it. A new session takes over, and the one
    /// it replaces is told.
    func testANewSessionSupersedesOneThatAllowsIt() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let told = Released()
        let first = try await s.beginWork(
            .session, supersedable: true, onSuperseded: { await told.record("first") })
        let second = try await s.beginWork(.session, supersedable: true)
        XCTAssertNotEqual(first.token, second.token)
        let names = await told.names
        XCTAssertEqual(names, ["first"])
        let work = await s.currentWork
        XCTAssertEqual(work, .session)
        await s.end(token: second.token)
    }

    /// The replaced connection's handler may still be mid-frame. Its work is
    /// refused rather than run against the session that replaced it.
    func testWorkUnderASupersededTokenIsRefused() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let first = try await s.beginWork(.session, supersedable: true)
        let second = try await s.beginWork(.session, supersedable: true)
        do {
            _ = try await s.withWork(token: first.token) { $0 }
            XCTFail("work ran under a superseded token")
        } catch let error as SlotError {
            guard case .superseded = error else { return XCTFail("expected superseded, got \(error)") }
        }
        let seen = try await s.withWork(token: second.token) { $0 }
        XCTAssertEqual(seen, "model-a")
        await s.end(token: second.token)
    }

    /// Two predictions at once is the crash the slot exists to prevent, so a
    /// takeover waits for the operation already running under the old token.
    func testSupersessionWaitsForWorkInFlight() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let order = Released()
        let first = try await s.beginWork(.session, supersedable: true)
        let running = Task {
            try await s.withWork(token: first.token) { _ in
                try await Task.sleep(for: .milliseconds(100))
                await order.record("old work done")
            }
        }
        try await Task.sleep(for: .milliseconds(20))
        let second = try await s.beginWork(.session, supersedable: true)
        await order.record("new session began")
        try await running.value
        let names = await order.names
        XCTAssertEqual(names, ["old work done", "new session began"])
        await s.end(token: second.token)
    }

    /// The old handler releases on its way out; that must not end the session
    /// that replaced it.
    func testALateEndFromTheSupersededSessionLeavesTheNewOne() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let first = try await s.beginWork(.session, supersedable: true)
        let second = try await s.beginWork(.session, supersedable: true)
        await s.end(token: first.token)
        let busy = await s.isBusy
        XCTAssertTrue(busy)
        _ = try await s.withWork(token: second.token) { $0 }
        await s.end(token: second.token)
    }

    /// Only work that allows it is superseded. A session that did not, and
    /// work of another kind, still exclude a newcomer as before.
    func testWorkThatDoesNotAllowSupersessionStillExcludes() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let held = try await s.beginWork(.session)
        do {
            _ = try await s.beginWork(.session, supersedable: true)
            XCTFail("superseded a session that did not allow it")
        } catch let error as SlotError {
            guard case .busy(let work) = error else { return XCTFail("expected busy, got \(error)") }
            XCTAssertEqual(work, .session)
        }
        await s.end(token: held.token)
    }

    func testABatchRequestDoesNotSupersedeASession() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let session = try await s.beginWork(.session, supersedable: true)
        do {
            _ = try await s.withModel(.batch) { $0 }
            XCTFail("a batch request took the slot from a session")
        } catch let error as SlotError {
            guard case .busy = error else { return XCTFail("expected busy, got \(error)") }
        }
        await s.end(token: session.token)
    }

    /// Unload refuses rather than waiting: it is a caller's mistake during live
    /// work, and stalling would hide it.
    func testUnloadIsRefusedWhileWorkIsLive() async throws {
        let s = slot()
        try await s.load(id: "a") { "model-a" }
        let begun = try await s.beginWork(.session)
        do {
            try await s.unload()
            XCTFail("unload ran during live work")
        } catch let error as SlotError {
            guard case .busy = error else { return XCTFail("expected busy, got \(error)") }
        }
        await s.end(token: begun.token)
    }
}

/// Records what the slot released, for the assertions above.
private actor Released {
    private(set) var names: [String] = []
    func record(_ id: String) { names.append(id) }
}
