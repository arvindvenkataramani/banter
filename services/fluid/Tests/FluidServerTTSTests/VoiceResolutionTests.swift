import FluidServerKit
import Foundation
import Logging
import XCTest

@testable import FluidServerTTS

/// The voice resolution rule of `docs/reference/design/model-roster.md`, "Resolving a
/// voice". The cases are shared with the TypeScript suite in
/// `control/test/voice-resolution.test.ts`, which reads the same file: a rule
/// changed here and not there fails one of them.
///
/// The server resolves only for itself, so this suite runs the cases whose
/// `runtime` is the file's `swiftProvider`.
final class VoiceResolutionTests: XCTestCase {
    private struct Shared: Decodable {
        let swiftProvider: String
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let voice: String
        let model: String
        let serviceId: String
        let expect: Expect
    }

    private struct Expect: Decodable {
        let refused: Bool?
        let modelKey: String?
        let presetKey: String?
        let recordingAudio: String?
        let recordingText: String?
    }

    /// The keys an `expect` may hold. A shape this suite does not recognise fails
    /// rather than being skipped.
    private static let expectKeys: Set<String> = [
        "refused", "modelKey", "presetKey", "recordingAudio", "recordingText",
    ]

    private static let repo = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../..").standardizedFileURL

    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-resolution-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// The case file's roster, written out as the registry a server is launched with.
    private func loadSharedRoster() throws -> (Shared, TtsRoster, [String: Any]) {
        let file = Self.repo.appendingPathComponent("schemas/voice-resolution-cases.json")
        let data = try Data(contentsOf: file)
        let shared = try JSONDecoder().decode(Shared.self, from: data)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let registry = directory.appendingPathComponent("registry.json")
        try JSONSerialization.data(withJSONObject: [
            "version": 4, "services": object["services"]!, "roster": object["roster"]!,
        ]).write(to: registry)
        let roster = try TtsRoster.load(registry: registry, provider: shared.swiftProvider)
        return (shared, roster, object)
    }

    func testEverySharedCaseResolvesAsTheRuleSays() throws {
        let (shared, roster, object) = try loadSharedRoster()

        let rawCases = try XCTUnwrap(object["cases"] as? [[String: Any]])
        for raw in rawCases {
            let keys = Set(try XCTUnwrap(raw["expect"] as? [String: Any]).keys)
            XCTAssertTrue(
                keys.isSubset(of: Self.expectKeys),
                "\(raw["name"] ?? ""): the case file names an expectation this suite does not know")
        }

        let mine = shared.cases.filter { $0.serviceId == shared.swiftProvider }
        XCTAssertFalse(mine.isEmpty)
        for testCase in mine {
            let expect = testCase.expect
            if expect.refused == true {
                XCTAssertThrowsError(
                    try roster.resolve(voice: testCase.voice, model: testCase.model), testCase.name
                ) { error in
                    // The refusal has to say which voice and which model, or
                    // the caller is left guessing at a 400.
                    let message = "\(error)"
                    XCTAssertTrue(message.contains(testCase.voice), "\(testCase.name): \(message)")
                    XCTAssertTrue(message.contains(testCase.model), "\(testCase.name): \(message)")
                }
                continue
            }
            XCTAssertEqual(
                roster.key(for: testCase.model), try XCTUnwrap(expect.modelKey), testCase.name)
            let resolved = try roster.resolve(voice: testCase.voice, model: testCase.model)
            if let presetKey = expect.presetKey {
                XCTAssertEqual(resolved, .preset(presetKey), testCase.name)
            } else {
                XCTAssertEqual(
                    resolved,
                    .clone(
                        audio: try XCTUnwrap(expect.recordingAudio), text: expect.recordingText),
                    testCase.name)
            }
        }
    }

    /// The fluid example registry loads, and its presets resolve to each model's
    /// own key: Kokoro under fluid-tts's key for it, Pocket-TTS by voice name.
    func testTheFluidExampleRegistryResolvesItsPresets() throws {
        let file = Self.repo.appendingPathComponent("services/fluid/registry.fluid.example.json")
        let roster = try TtsRoster.load(registry: file, provider: "fluid-tts")

        XCTAssertEqual(roster.key(for: "kokoro-82m"), "kokoro-ane")
        XCTAssertEqual(try roster.resolve(voice: "alloy", model: "kokoro-82m"), .preset("af_alloy"))
        XCTAssertEqual(try roster.resolve(voice: "eponine", model: "pocket-tts"), .preset("eponine"))
        XCTAssertThrowsError(try roster.resolve(voice: "alloy", model: "pocket-tts"))
    }

    // MARK: - What the speech route and the socket do with a voice name

    private func context(roster: TtsRoster) -> TtsAppContext {
        let resident = ResidentTtsModel(
            modelsDirectory: nil,
            temporaryDirectory: FileManager.default.temporaryDirectory,
            logger: Logger(label: "test"),
            waitDeadline: .seconds(5),
            makeDriver: { _, _, _ in try await SlowStreamingDriver(modelsDirectory: nil) })
        return TtsAppContext(
            resident: resident, roster: roster, logger: Logger(label: "test"),
            identity: AppIdentity(
                bundleIdentifier: "test.fluid-tts", shortVersion: "0.0.0", buildVersion: "test"))
    }

    /// Nothing passes through: a name that is not a declared voice with a
    /// rendering on the requested model is refused, naming both, not answered
    /// with the runtime's default voice. `voiceTerms` is the one place the
    /// speech route and the socket turn a voice name into what a driver is given.
    func testAVoiceNameThatIsNotADeclaredVoiceRenderedByTheModelIsRefused() async throws {
        let (_, roster, _) = try loadSharedRoster()
        let ctx = context(roster: roster)

        for (voice, model) in [("alba", "pocket-tts"), ("eponine", "luxtts")] {
            do {
                _ = try await ctx.voiceTerms(voice: voice, refAudio: nil, refText: nil, model: model)
                XCTFail("\(voice) on \(model) was passed through")
            } catch {
                let message = "\(error)"
                XCTAssertTrue(message.contains(voice), message)
                XCTAssertTrue(message.contains(model), message)
            }
        }
    }

    func testADeclaredVoiceRenderedByTheModelIsGivenItsRecording() async throws {
        let (_, roster, _) = try loadSharedRoster()
        let terms = try await context(roster: roster).voiceTerms(
            voice: "nicole", refAudio: nil, refText: nil, model: "pocket-tts")
        XCTAssertEqual(terms.refAudio?.path, "/refs/voices/nicole.wav")
        XCTAssertNil(terms.refText)
    }

    /// A benchmark may name an arbitrary recording: that request has chosen it
    /// and nothing is looked up, so a voice name the roster lacks does not matter.
    func testARequestCarryingARecordingHasChosenItAndNothingIsLookedUp() async throws {
        let (_, roster, _) = try loadSharedRoster()
        let terms = try await context(roster: roster).voiceTerms(
            voice: "not-a-voice", refAudio: "/tmp/chosen.wav", refText: nil, model: "pocket-tts")
        XCTAssertEqual(terms.refAudio?.path, "/tmp/chosen.wav")
    }

    /// The voice name names no recording, so a request that carries one does not
    /// hand the driver the name as well, declared voice or not.
    func testARequestCarryingARecordingDoesNotForwardTheVoiceName() async throws {
        let (_, roster, _) = try loadSharedRoster()
        let ctx = context(roster: roster)
        for name in ["not-a-voice", "nicole"] {
            let terms = try await ctx.voiceTerms(
                voice: name, refAudio: "/tmp/chosen.wav", refText: nil, model: "pocket-tts")
            XCTAssertNil(terms.voice, name)
        }
    }

    /// With no model named and none resident there is nothing to resolve the
    /// voice under; the name is refused rather than passed to the driver.
    func testAVoiceWithNoModelNamedAndNoneResidentIsRefused() async throws {
        let (_, roster, _) = try loadSharedRoster()
        do {
            _ = try await context(roster: roster).voiceTerms(
                voice: "nicole", refAudio: nil, refText: nil, model: nil)
            XCTFail("the voice was passed through")
        } catch {
            XCTAssertTrue("\(error)".contains("no model is named"), "\(error)")
        }
    }
}
