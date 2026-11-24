import FluidAudio
import FluidServerKit
import Foundation
import Logging
import XCTest

@testable import FluidServerSTT

/// `triton.model-repository` with `resident-slot`, as `fluid-stt` serves it
/// (spec section 9, "Triton routes"). The routes are driven over a real
/// socket on a loopback port, with models built by a stand-in builder: managers
/// constructed without weights, enough to occupy the slot and report modes.
///
/// The roster's ids equal their runtime keys, as the fluid example registry's
/// do, so the model name on the route is the same either way.
final class TritonRoutesTests: XCTestCase {
    private actor Loads {
        private(set) var count = 0
        func add() { count += 1 }
    }

    private struct Harness {
        let live: LiveServer
        let resident: ResidentModel
        let loads: Loads
    }

    private func start() async throws -> Harness {
        let tiers = [560, 1120].map {
            RosterVariant(id: "\($0)ms", params: [ParamBinding(name: "chunkMs", value: $0)])
        }
        let roster = try Roster.validate(
            [
                RosterEntry(
                    id: "parakeet-tdt-v3", name: "TDT", key: "parakeet-tdt-v3", kind: .batch,
                    params: nil, variants: nil),
                RosterEntry(
                    id: "parakeet-unified-0.6b", name: "Both", key: "parakeet-unified-0.6b", kind: .both,
                    params: nil, variants: nil),
                RosterEntry(
                    id: "nemotron-streaming-en-0.6b", name: "Stream", key: "nemotron-streaming-en-0.6b", kind: .streaming,
                    params: [RosterParam(name: "chunkMs", values: [560, 1120])], variants: tiers),
            ], defaultModel: "parakeet-unified-0.6b")
        let loads = Loads()
        let builder = ModelBuilder(
            load: { model, mode, _ in
                await loads.add()
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
                        id: model.id,
                        manager: StreamingNemotronAsrManager(requestedChunkSize: .ms1120),
                        chunkMs: 1120)
                }
            },
            addMode: { _, _ in nil },
            isPresent: { _ in true })
        let resident = ResidentModel(
            roster: roster, logger: Logger(label: "test"), waitDeadline: .seconds(2),
            builder: builder)
        let ctx = AppContext(
            resident: resident, logger: Logger(label: "test"),
            identity: AppIdentity(
                bundleIdentifier: "test.fluid-stt", shortVersion: "0.0.0", buildVersion: "test"),
            temporaryDirectory: FileManager.default.temporaryDirectory)
        let live = try await LiveServer.start(
            router: buildRouter(ctx: ctx), webSockets: buildStreamRouter(ctx: ctx))
        return Harness(live: live, resident: resident, loads: loads)
    }

    private func load(
        _ h: Harness, _ name: String, parameters: [String: Any] = [:]
    ) async throws -> HttpReply {
        try await h.live.postJSON("/v2/repository/models/\(name)/load", ["parameters": parameters])
    }

    private func index(_ h: Harness) async throws -> [[String: Any]] {
        let reply = try await h.live.postJSON("/v2/repository/index", [String: Any]())
        XCTAssertEqual(reply.status, 200)
        return try XCTUnwrap(reply.json as? [[String: Any]], "the index is a JSON array")
    }

    func testS1_ALoadWithNoParametersLoadsTheDefaultModeOfASingleModeModel() async throws {
        let h = try await start()
        let reply = try await load(h, "parakeet-tdt-v3")
        XCTAssertEqual(reply.status, 200, reply.text)
        let loaded = await h.resident.loadedId
        let modes = await h.resident.residentModes
        XCTAssertEqual(loaded, "parakeet-tdt-v3")
        XCTAssertEqual(modes, ["batch"])
        await h.live.stop()
    }

    func testS1_ALoadOfABothModeModelWithoutAModeIsRefusedWith400() async throws {
        let h = try await start()
        let reply = try await load(h, "parakeet-unified-0.6b")
        XCTAssertEqual(reply.status, 400)
        XCTAssertNotNil(reply.object?["error"] as? String, "a failure carries {\"error\": ...}")
        let loaded = await h.resident.loadedId
        XCTAssertNil(loaded)
        await h.live.stop()
    }

    func testS1_TheModeParameterSelectsWhichHalfOfABothModeModelLoads() async throws {
        let h = try await start()
        let reply = try await load(h, "parakeet-unified-0.6b", parameters: ["mode": "streaming"])
        XCTAssertEqual(reply.status, 200, reply.text)
        let modes = await h.resident.residentModes
        XCTAssertEqual(modes, ["streaming"])
        await h.live.stop()
    }

    func testS1_TheVariantParameterSelectsTheTierOfAModelThatHasOne() async throws {
        let h = try await start()
        let reply = try await load(h, "nemotron-streaming-en-0.6b", parameters: ["variant": "1120ms"])
        XCTAssertEqual(reply.status, 200, reply.text)
        let variant = await h.resident.loadedVariant
        XCTAssertEqual(variant, "1120ms")
        await h.live.stop()
    }

    func testS1_ALoadOfAModelTheRosterLacksIsRefusedWith400NamingIt() async throws {
        let h = try await start()
        let reply = try await load(h, "no-such-model")
        XCTAssertEqual(reply.status, 400)
        let message = try XCTUnwrap(reply.object?["error"] as? String)
        XCTAssertTrue(message.contains("no-such-model"), message)
        await h.live.stop()
    }

    /// Triton reloads a loaded model; `resident-slot` does not, because a reload
    /// costs seconds and voice mode on a second device loads before it takes over.
    func testS1_ALoadOfTheResidentModelIs200AndBuildsNothing() async throws {
        let h = try await start()
        _ = try await load(h, "parakeet-unified-0.6b", parameters: ["mode": "streaming"])
        let again = try await load(h, "parakeet-unified-0.6b", parameters: ["mode": "streaming"])
        XCTAssertEqual(again.status, 200, again.text)
        let loads = await h.loads.count
        XCTAssertEqual(loads, 1)
        await h.live.stop()
    }

    func testS1_ALoadThatWouldChangeTheModelWhileASessionHoldsTheServerIs409() async throws {
        let h = try await start()
        let session = try await h.resident.beginSession(expecting: "parakeet-unified-0.6b", session: "a")

        let reply = try await load(h, "parakeet-tdt-v3")

        XCTAssertEqual(reply.status, 409)
        let loaded = await h.resident.loadedId
        XCTAssertEqual(loaded, "parakeet-unified-0.6b")
        await h.resident.endSession(token: session.token, claim: session.claim)
        await h.live.stop()
    }

    func testS1_AnUnloadWhileASessionHoldsTheServerIs409() async throws {
        let h = try await start()
        let session = try await h.resident.beginSession(expecting: "parakeet-unified-0.6b", session: "a")

        let reply = try await h.live.postJSON("/v2/repository/models/parakeet-unified-0.6b/unload", [String: Any]())

        XCTAssertEqual(reply.status, 409)
        let loaded = await h.resident.loadedId
        XCTAssertEqual(loaded, "parakeet-unified-0.6b")
        await h.resident.endSession(token: session.token, claim: session.claim)
        await h.live.stop()
    }

    func testS1_AnUnloadEmptiesTheServerAndTheIndexShowsIt() async throws {
        let h = try await start()
        _ = try await load(h, "parakeet-tdt-v3")

        let reply = try await h.live.postJSON("/v2/repository/models/parakeet-tdt-v3/unload", [String: Any]())

        XCTAssertEqual(reply.status, 200, reply.text)
        let loaded = await h.resident.loadedId
        XCTAssertNil(loaded)
        let states = try await index(h).map { $0["state"] as? String }
        XCTAssertEqual(states.filter { $0 == "READY" }.count, 0)
        await h.live.stop()
    }

    func testS1_TheIndexListsEveryRosterModelReadyOnlyForTheResidentOne() async throws {
        let h = try await start()
        _ = try await load(h, "parakeet-tdt-v3")

        let entries = try await index(h)

        XCTAssertEqual(
            Set(entries.compactMap { $0["name"] as? String }),
            ["parakeet-tdt-v3", "parakeet-unified-0.6b", "nemotron-streaming-en-0.6b"])
        for entry in entries {
            XCTAssertNotNil(entry["reason"] as? String, "each entry carries a reason: \(entry)")
            let expected = entry["name"] as? String == "parakeet-tdt-v3" ? "READY" : "UNAVAILABLE"
            XCTAssertEqual(entry["state"] as? String, expected, "\(entry)")
        }
        await h.live.stop()
    }
}
