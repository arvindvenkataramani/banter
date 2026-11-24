import FluidServerKit
import Foundation
import Logging
import XCTest

@testable import FluidServerSTT

/// A running `fluid-stt` router over models that need no weights.
///
/// INVENTED seam:
/// `LoadedModel.scripted(id:text:)` is a loaded model whose streaming session
/// and batch transcription answer `text` once any audio has reached them since
/// the last reset, and the empty string before. It reports both modes. The
/// roster's kinds still decide what a request may ask of a model.
///
/// The roster's ids equal their runtime keys, as the fluid example registry's
/// do. Its default model is the batch-only `parakeet-tdt-v3`, so a request that
/// opens a session and names no model fails, and one that works shows that its
/// `model` was honoured.
struct SttHarness {
    let live: LiveServer
    let resident: ResidentModel
}

let scriptedText = "hello world"

func startSttServer() async throws -> SttHarness {
    let roster = try Roster.validate(
        [
            RosterEntry(
                id: "parakeet-tdt-v3", name: "TDT", key: "parakeet-tdt-v3", kind: .batch,
                params: nil, variants: nil),
            RosterEntry(
                id: "parakeet-unified-0.6b", name: "Unified", key: "parakeet-unified-0.6b",
                kind: .both, params: nil, variants: nil),
        ], defaultModel: "parakeet-tdt-v3")
    let builder = ModelBuilder(
        load: { model, _, _ in .scripted(id: model.id, text: scriptedText) },
        addMode: { _, _ in nil },
        isPresent: { _ in true })
    let resident = ResidentModel(
        roster: roster, logger: Logger(label: "test"), waitDeadline: .seconds(2), builder: builder)
    let ctx = AppContext(
        resident: resident, logger: Logger(label: "test"),
        identity: AppIdentity(
            bundleIdentifier: "test.fluid-stt", shortVersion: "0.0.0", buildVersion: "test"),
        temporaryDirectory: FileManager.default.temporaryDirectory)
    let live = try await LiveServer.start(
        router: buildRouter(ctx: ctx), webSockets: buildStreamRouter(ctx: ctx))
    return SttHarness(live: live, resident: resident)
}

/// A sine tone loud enough to count as speech, as 16-bit little-endian samples.
func tone(ms: Int, rate: Int = 16000) -> Data {
    pcm16((0..<(rate * ms / 1000)).map { Float(sin(Double($0) * 0.2)) * 0.3 })
}

func silence(ms: Int, rate: Int = 16000) -> Data {
    pcm16([Float](repeating: 0, count: rate * ms / 1000))
}

private func pcm16(_ samples: [Float]) -> Data {
    var data = Data()
    for sample in samples {
        let value = Int16(max(-1, min(1, sample)) * 32767)
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }
    return data
}

/// INVENTED: One Opus packet that decodes to 20 ms of silence, a fact about Opus
/// and not about the spec.
let opusSilencePacket = Data([0xF8, 0xFF, 0xFE])

extension WSClient {
    /// The next `Results` message, skipping other messages.
    func nextResults(timeout: Duration = .seconds(5)) async -> [String: Any]? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            guard let event = await nextText(timeout: deadline - ContinuousClock.now) else { return nil }
            if case .closed = event { return nil }
            if event.type == "Results" { return event.object }
        }
        return nil
    }

    /// The next `Results` message that answers a `Finalize`.
    func nextFinalizeResult(timeout: Duration = .seconds(5)) async -> [String: Any]? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            guard let results = await nextResults(timeout: deadline - ContinuousClock.now) else { return nil }
            if results["from_finalize"] as? Bool == true { return results }
        }
        return nil
    }
}

/// What a test needed from the server and did not get in time.
struct NothingArrived: Error, CustomStringConvertible {
    let wanted: String
    var description: String { "nothing arrived: \(wanted)" }
}

extension WSClient {
    func requireFinalizeResult(timeout: Duration = .seconds(5)) async throws -> [String: Any] {
        guard let results = await nextFinalizeResult(timeout: timeout) else {
            throw NothingArrived(wanted: "a Results answering a Finalize")
        }
        return results
    }

    func requireText(timeout: Duration = .seconds(5)) async throws -> Event {
        guard let event = await nextText(timeout: timeout) else {
            throw NothingArrived(wanted: "a text message")
        }
        return event
    }

    /// Text messages until one has `type`, which is returned. Throws if the
    /// connection ends or the time passes first.
    func require(type: String, timeout: Duration = .seconds(5)) async throws -> [String: Any] {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            guard let event = await nextText(timeout: deadline - ContinuousClock.now) else { break }
            if case .closed(let code) = event { throw NothingArrived(wanted: "\(type); closed with \(code)") }
            if event.type == type, let object = event.object { return object }
        }
        throw NothingArrived(wanted: type)
    }
}

func transcript(of results: [String: Any]) -> String? {
    let channel = results["channel"] as? [String: Any]
    let first = (channel?["alternatives"] as? [[String: Any]])?.first
    return first?["transcript"] as? String
}
