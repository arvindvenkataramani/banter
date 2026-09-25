import FluidAudio
import FluidServerKit
import Foundation

/// What a caller asks for. `model` selects the backend; the rest are the union
/// of what the eight managers accept, each ignoring what it does not use.
public struct SynthesisRequest: Sendable {
    let text: String
    let voice: String?
    let refAudio: URL?
    let refText: String?
    let language: String?
    let speed: Float?
    let temperature: Float?
    let seed: UInt64?
    let cfgWeight: Float?
    let repetitionPenalty: Float?
    let minP: Float?
    let topP: Float?
    let topK: Int?
    let emotion: String?
    let deEss: Bool?
    let maxTokensPerChunk: Int?
    let alpha: Float?
    let beta: Float?
    let noiseScale: Float?
    let totalSteps: Int?
    let silenceDuration: Float?
}

public struct SynthesisResult: Sendable {
    let samples: [Float]
    let sampleRate: Int
}

/// FluidAudio has no common TTS interface: every backend is its own actor with
/// its own constructor, its own `synthesize` shape, and its own return type
/// (`Data`, `[Float]`, or a per-backend `Audio`). This protocol is where that
/// divergence is absorbed, so the HTTP layer sees one call.
public protocol TtsBackendDriver: Sendable {
    static var id: String { get }
    /// Backends whose only voice is the one they were trained with. The bench
    /// config must not pass them cloning references.
    static var supportsCloning: Bool { get }
    static var sampleRate: Int { get }

    init(modelsDirectory: URL?) async throws
    func load() async throws
    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult
}

/// A backend that can yield audio before the utterance is finished.
///
/// Separate from `TtsBackendDriver` rather than an optional method on it: the
/// seven backends with only a whole-utterance `synthesize` need no edit, and a
/// streaming model arriving later conforms by adding one method.
///
/// The driver's only job is to yield samples as they exist. Buffering, WAV
/// framing and flush live outside it, so a new driver inherits the TTFB
/// behaviour rather than reimplementing it.
public protocol TtsStreamingDriver: TtsBackendDriver {
    /// Throws before yielding anything for a failure the caller can still be
    /// told about — an unencodable reference, a model that will not start. Once
    /// the stream exists the response headers are sent and a failure can only
    /// truncate.
    func stream(_ request: SynthesisRequest) async throws
        -> (stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
}

public enum TtsError: Error, CustomStringConvertible {
    case unknownModel(String)
    case missingReference(String)
    case notLoaded
    /// The loaded model is not the one the caller expects.
    case modelMismatch(String)
    case unsupported(String)
    case busy
    case unknownFormat(String)

    public var description: String {
        switch self {
        case .unknownModel(let m): return "unknown model '\(m)'"
        case .missingReference(let m): return m
        case .notLoaded: return "no model is loaded"
        case .modelMismatch(let m): return m
        case .unsupported(let m): return m
        case .unknownFormat(let f):
            return "unknown response_format '\(f)'; expected aac or wav"
        case .busy:
            return "the model is busy with another request; one runs at a time"
        }
    }
}

extension TtsError: SocketCoded {
    /// The nearest fit on the shared table: `fluid-tts` has no roster/mode
    /// conditions of its own, so `unknownModel` and `modelMismatch` both read
    /// as "the model I expect is not the one that's loaded."
    public var socketCode: SocketErrorCode {
        switch self {
        case .notLoaded:
            return .modelNotLoaded
        case .unknownModel, .modelMismatch:
            return .modelMismatch
        case .busy:
            return .busy
        case .unknownFormat:
            return .badFormat
        case .missingReference, .unsupported:
            return .failed
        }
    }
}

// MARK: - PocketTTS

actor PocketTtsDriver: TtsBackendDriver {
    static let id = "pocket-tts"
    static let supportsCloning = true
    static let sampleRate = 24000

    private let manager: PocketTtsManager
    /// Cloned voices keyed by reference path. Encoding a reference costs a Mimi
    /// encoder pass, and a benchmark sends the same four references repeatedly.
    private var clonedVoices: [String: PocketTtsVoiceData] = [:]

    init(modelsDirectory: URL?) async throws {
        // PocketTTS is the only backend that appends its own `Models/` to the
        // directory it is given; the other seven treat it as the models root
        // directly. Passing the shared root unchanged resolves to
        // `Models/Models/pocket-tts-coreml/`, where the weights are not, and
        // cloning then reports its encoder missing rather than the path being
        // wrong. Strip the trailing component so both conventions land in one
        // tree.
        let adjusted = modelsDirectory.map { dir -> URL in
            dir.lastPathComponent == PocketTtsConstants.defaultModelsSubdirectory
                ? dir.deletingLastPathComponent() : dir
        }
        manager = PocketTtsManager(directory: adjusted)
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        let temperature = request.temperature ?? PocketTtsConstants.temperature
        let deEss = request.deEss ?? true
        let maxTokens = request.maxTokensPerChunk ?? PocketTtsConstants.maxTokensPerChunk

        // Cloning takes a different call than a preset voice: the reference is
        // encoded to PocketTtsVoiceData first, and `voice:` selects a shipped
        // preset instead. Passing a reference to the preset path silently
        // returns the default voice.
        if let ref = request.refAudio {
            // `mimi_encoderv2.mlmodelc` at the repo root is what encodes a
            // reference, and the language-pack download does not bring it —
            // fetch it explicitly when provisioning a cache.
            let key = ref.path
            if clonedVoices[key] == nil {
                // `cloneVoice` loads the Mimi encoder itself. An availability
                // pre-check here reads a language root that is only set once
                // the pack has loaded, so it answers false on a cold manager
                // and refuses a clone the encoder could have served.
                clonedVoices[key] = try await manager.cloneVoice(from: ref)
            }
            guard let voiceData = clonedVoices[key] else {
                throw TtsError.unsupported("pocket-tts could not clone \(ref.lastPathComponent)")
            }
            let wav = try await manager.synthesize(
                text: request.text,
                voiceData: voiceData,
                temperature: temperature,
                deEss: deEss,
                maxTokensPerChunk: maxTokens)
            return SynthesisResult(
                samples: try decodeWavSamples(wav), sampleRate: Self.sampleRate)
        }

        let wav = try await manager.synthesize(
            text: request.text,
            voice: request.voice,
            temperature: temperature,
            deEss: deEss,
            maxTokensPerChunk: maxTokens)
        return SynthesisResult(
            samples: try decodeWavSamples(wav), sampleRate: Self.sampleRate)
    }
}

extension PocketTtsDriver: TtsStreamingDriver {
    /// The cloning path resolves its reference before the stream exists, so a
    /// reference that cannot be encoded fails while the caller can still be
    /// told why. `clonedVoices` is the same cache the batch path fills: a
    /// benchmark sending one reference repeatedly pays the Mimi encoder pass
    /// once either way.
    func stream(_ request: SynthesisRequest) async throws
        -> (stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
    {
        let temperature = request.temperature ?? PocketTtsConstants.temperature
        let maxTokens = request.maxTokensPerChunk ?? PocketTtsConstants.maxTokensPerChunk

        let frames: AsyncThrowingStream<PocketTtsSynthesizer.AudioFrame, Error>
        if let ref = request.refAudio {
            let key = ref.path
            if clonedVoices[key] == nil {
                clonedVoices[key] = try await manager.cloneVoice(from: ref)
            }
            guard let voiceData = clonedVoices[key] else {
                throw TtsError.unsupported("pocket-tts could not clone \(ref.lastPathComponent)")
            }
            frames = try await manager.synthesizeStreaming(
                text: request.text,
                voiceData: voiceData,
                temperature: temperature,
                maxTokensPerChunk: maxTokens)
        } else {
            frames = try await manager.synthesizeStreaming(
                text: request.text,
                voice: request.voice,
                temperature: temperature,
                maxTokensPerChunk: maxTokens)
        }

        // The frame's own indices describe FluidAudio's chunking of the text,
        // which is not the buffering boundary anything downstream uses.
        let samples = AsyncThrowingStream<[Float], Error> { continuation in
            Task {
                do {
                    for try await frame in frames { continuation.yield(frame.samples) }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
        return (samples, Self.sampleRate)
    }
}

// MARK: - Kokoro (ANE)

actor KokoroAneDriver: TtsBackendDriver {
    static let id = "kokoro-ane"
    static let supportsCloning = false
    static let sampleRate = 24000

    private let manager: KokoroAneManager

    init(modelsDirectory: URL?) async throws {
        manager = KokoroAneManager(directory: modelsDirectory)
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        // KokoroAne caps IPA input at 512 tokens and throws
        // `phonemeSequenceTooLong` beyond it — its own docs say to chunk
        // upstream, and unlike StyleTTS2 and Inflect it does no chunking
        // internally. Split on sentences and concatenate, as StyleTTS2 does
        // with its phoneme chunks.
        var samples: [Float] = []
        for chunk in splitIntoChunks(request.text, maxCharacters: 320) {
            let wav = try await manager.synthesize(
                text: chunk,
                voice: request.voice,
                speed: request.speed ?? KokoroAneConstants.defaultSpeed)
            samples.append(contentsOf: try decodeWavSamples(wav))
        }
        return SynthesisResult(samples: samples, sampleRate: Self.sampleRate)
    }
}

/// Split text into pieces under `maxCharacters`, for backends with a hard
/// input cap and no chunker of their own.
///
/// Whole sentences wherever they fit. A sentence longer than the cap is cut at
/// clause punctuation first, and only at a word boundary when it has none —
/// a seam at a comma is covered by a pause the listener expects, where a seam
/// between words is heard as an interruption.
///
/// The caps are in characters because that is all a caller can measure without
/// each backend's own tokenizer; FluidAudio's Pocket-TTS chunker applies the
/// same rules in tokens.
func splitIntoChunks(_ text: String, maxCharacters: Int) -> [String] {
    let trimmed = collapseWhitespace(text)
    guard trimmed.count > maxCharacters else { return [trimmed] }

    var chunks: [String] = []
    var buffer = ""
    for sentence in splitIntoSentences(trimmed) {
        if sentence.count > maxCharacters {
            if !buffer.isEmpty { chunks.append(buffer); buffer = "" }
            chunks.append(contentsOf: splitOversized(sentence, maxCharacters: maxCharacters))
            continue
        }
        if buffer.count + sentence.count + 1 > maxCharacters, !buffer.isEmpty {
            chunks.append(buffer)
            buffer = sentence
        } else {
            buffer += buffer.isEmpty ? sentence : " \(sentence)"
        }
    }
    if !buffer.isEmpty { chunks.append(buffer) }
    return chunks.isEmpty ? [trimmed] : chunks
}

/// Collapse every whitespace run to a single space. A newline is whitespace to
/// a reader but a character to a tokenizer, and sizing a chunk before
/// collapsing measures text that is never synthesized.
func collapseWhitespace(_ text: String) -> String {
    text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}

/// Split into sentences. A run of terminators ("...", "?!") ends one sentence,
/// not several.
func splitIntoSentences(_ text: String) -> [String] {
    let terminators: Set<Character> = [".", "!", "?"]
    var sentences: [String] = []
    var current = ""
    let chars = Array(text)
    for (i, character) in chars.enumerated() {
        current.append(character)
        guard terminators.contains(character) else { continue }
        if i + 1 < chars.count, terminators.contains(chars[i + 1]) { continue }
        let piece = current.trimmingCharacters(in: .whitespaces)
        if !piece.isEmpty { sentences.append(piece) }
        current = ""
    }
    let tail = current.trimmingCharacters(in: .whitespaces)
    if !tail.isEmpty { sentences.append(tail) }
    return sentences
}

/// Cut one oversized sentence: clause boundaries first, word boundaries only
/// for what still does not fit.
private func splitOversized(_ sentence: String, maxCharacters: Int) -> [String] {
    var chunks: [String] = []
    var buffer = ""
    for clause in splitAtClauseBoundaries(sentence) {
        if clause.count > maxCharacters {
            if !buffer.isEmpty { chunks.append(buffer); buffer = "" }
            chunks.append(contentsOf: splitAtWordBoundaries(clause, maxCharacters: maxCharacters))
            continue
        }
        if buffer.count + clause.count + 1 > maxCharacters, !buffer.isEmpty {
            chunks.append(buffer)
            buffer = clause
        } else {
            buffer += buffer.isEmpty ? clause : " \(clause)"
        }
    }
    if !buffer.isEmpty { chunks.append(buffer) }
    return chunks
}

/// Split at clause punctuation: commas, semicolons, colons, dashes, ellipses
/// and the edges of a bracketed aside.
///
/// Exceptions keep tokens whole: a comma between digits ("3,500") does not
/// split; an en dash or hyphen splits only with a space on each side, so
/// hyphenated words and ranges stay whole; a closing bracket or ellipsis
/// splits only when a space follows, so "aside)," stays attached.
func splitAtClauseBoundaries(_ text: String) -> [String] {
    let breakAfter: Set<Character> = [",", ";", ":", "\u{2014}"]
    let breakAfterWhenSpaced: Set<Character> = ["\u{2013}", "-"]
    let breakAfterBeforeSpace: Set<Character> = [")", "]", "\u{2026}"]
    let breakBefore: Set<Character> = ["(", "["]

    var parts: [String] = []
    var current = ""
    let chars = Array(text)

    func flush() {
        let trimmed = current.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { parts.append(trimmed) }
        current = ""
    }

    for (i, character) in chars.enumerated() {
        if breakBefore.contains(character) { flush() }
        current.append(character)

        let prevIsSpace = i > 0 && chars[i - 1] == " "
        let nextIsSpace = i + 1 < chars.count && chars[i + 1] == " "

        if breakAfterWhenSpaced.contains(character) {
            guard prevIsSpace && nextIsSpace else { continue }
        } else if breakAfterBeforeSpace.contains(character) {
            guard nextIsSpace else { continue }
        } else {
            guard breakAfter.contains(character) else { continue }
        }

        if character == "," {
            let prevIsDigit = i > 0 && chars[i - 1].isNumber
            let nextIsDigit = i + 1 < chars.count && chars[i + 1].isNumber
            if prevIsDigit && nextIsDigit { continue }
        }

        flush()
    }

    flush()
    return parts
}

/// Split at word boundaries, balanced. Text needing `n` parts aims each at a
/// `1/n` share: filling every part to the cap instead strands whatever spills
/// past the last full part as a short tail ("…the first drops hit" + "the
/// pavement."), and a two-word chunk is synthesized with a prosodic start of
/// its own. No part exceeds `maxCharacters`.
func splitAtWordBoundaries(_ text: String, maxCharacters: Int) -> [String] {
    let words = text.split(separator: " ").map(String.init)
    guard words.count > 1 else { return [text] }

    let total = text.count
    let partCount = max(1, (total + maxCharacters - 1) / maxCharacters)
    let target = min(maxCharacters, (total + partCount - 1) / partCount)

    var chunks: [String] = []
    var currentWords: [String] = []
    var currentCount = 0

    for word in words {
        let candidate = currentCount == 0 ? word.count : currentCount + 1 + word.count
        let isLastPart = chunks.count >= partCount - 1
        let closesPart: Bool
        if candidate > maxCharacters {
            closesPart = true
        } else if isLastPart || candidate <= target {
            closesPart = false
        } else {
            closesPart = candidate - target >= target - currentCount
        }

        if closesPart && !currentWords.isEmpty {
            chunks.append(currentWords.joined(separator: " "))
            currentWords = [word]
            currentCount = word.count
        } else {
            currentWords.append(word)
            currentCount = candidate
        }
    }
    if !currentWords.isEmpty { chunks.append(currentWords.joined(separator: " ")) }

    // A single-word tail is the greedy split's orphan: donate one word back so
    // it has at least two and starts less abruptly.
    if chunks.count > 1, let last = chunks.last, !last.contains(" ") {
        let previous = chunks[chunks.count - 2]
        var previousWords = previous.split(separator: " ").map(String.init)
        if previousWords.count > 2, let donated = previousWords.popLast() {
            chunks[chunks.count - 2] = previousWords.joined(separator: " ")
            chunks[chunks.count - 1] = "\(donated) \(last)"
        }
    }

    return chunks
}

// MARK: - Supertonic3

actor Supertonic3Driver: TtsBackendDriver {
    static let id = "supertonic3"
    static let supportsCloning = false
    static let sampleRate = 44100

    private let manager: Supertonic3Manager
    private var styleCache: [String: Supertonic3VoiceStyle] = [:]

    init(modelsDirectory: URL?) async throws {
        manager = Supertonic3Manager(directory: modelsDirectory)
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        // Voices are style tensors in per-voice JSON (F1–F5, M1–M5), fetched
        // and decoded separately rather than named on the call.
        let selected = request.voice.flatMap { Supertonic3Voice(rawValue: $0.uppercased()) }
            ?? Supertonic3Voice.default
        if styleCache[selected.rawValue] == nil {
            styleCache[selected.rawValue] =
                try await Supertonic3ResourceDownloader.loadVoiceStyle(selected)
        }
        guard let style = styleCache[selected.rawValue] else {
            throw TtsError.unsupported("could not load Supertonic3 voice style")
        }
        let result = try await manager.synthesize(
            text: request.text,
            language: request.language ?? "en",
            style: style,
            totalSteps: request.totalSteps ?? Supertonic3Constants.defaultTotalSteps,
            speed: request.speed ?? Supertonic3Constants.defaultSpeed,
            silenceDuration: request.silenceDuration
                ?? Supertonic3Constants.defaultSilenceDuration)
        return SynthesisResult(samples: result.samples, sampleRate: Self.sampleRate)
    }
}

// MARK: - StyleTTS2

actor StyleTts2Driver: TtsBackendDriver {
    static let id = "styletts2"
    static let supportsCloning = true
    static let sampleRate = 24000

    private let manager: StyleTTS2Manager

    init(modelsDirectory: URL?) async throws {
        manager = StyleTTS2Manager(directory: modelsDirectory)
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        guard let ref = request.refAudio else {
            throw TtsError.missingReference("styletts2 requires ref_audio")
        }
        // The reference encoder is fixed-shape: exactly
        // `StyleTts2ReferenceTrim.requiredMelFrames` mel frames, no more and no
        // fewer. Callers pass whole reference clips, so trim here rather than
        // making every caller know the number.
        let trimmed = try StyleTts2ReferenceTrim.trim(ref)
        defer { try? FileManager.default.removeItem(at: trimmed) }
        let samples = try await manager.synthesize(
            text: request.text,
            referenceAudioURL: trimmed,
            alpha: request.alpha ?? StyleTTS2Constants.defaultAlpha,
            beta: request.beta ?? StyleTTS2Constants.defaultBeta,
            noiseSeed: request.seed ?? 0)
        return SynthesisResult(samples: samples, sampleRate: Self.sampleRate)
    }
}

// MARK: - LuxTTS

actor LuxTtsDriver: TtsBackendDriver {
    static let id = "luxtts"
    static let supportsCloning = true
    static let sampleRate = 48000

    private let manager: LuxTtsManager

    init(modelsDirectory: URL?) async throws {
        manager = LuxTtsManager(directory: modelsDirectory)
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        guard let ref = request.refAudio else {
            throw TtsError.missingReference("luxtts requires ref_audio")
        }
        guard let refText = request.refText, !refText.isEmpty else {
            throw TtsError.missingReference("luxtts requires ref_text")
        }
        // The phonemized prompt and text share one 256-token budget, and
        // characters do not predict tokens: 200 characters of plain prose fit,
        // while an 86-character chunk containing "FastAPI" and "PWA" does not,
        // because the phonemizer spells acronyms out letter by letter. So chunk
        // optimistically and halve on overflow rather than guessing a character
        // budget that some text will always break.
        var samples: [Float] = []
        for chunk in splitIntoChunks(request.text, maxCharacters: 160) {
            samples.append(
                contentsOf: try await synthesizeFitting(
                    chunk, ref: ref, refText: refText, speed: request.speed,
                    seed: request.seed))
        }
        return SynthesisResult(samples: samples, sampleRate: Self.sampleRate)
    }

    /// Synthesize one chunk, splitting it further whenever the token budget
    /// rejects it. Splits at clause punctuation before word boundaries, so a
    /// seam lands where a speaker would pause; a chunk that cannot be split any
    /// further rethrows rather than looping.
    private func synthesizeFitting(
        _ text: String, ref: URL, refText: String, speed: Float?, seed: UInt64?,
        depth: Int = 0
    ) async throws -> [Float] {
        do {
            let result = try await manager.synthesize(
                text: text,
                promptAudio: ref,
                promptText: refText,
                speed: speed ?? LuxTtsConstants.defaultSpeed,
                seed: seed ?? LuxTtsConstants.defaultSeed)
            return result.samples
        } catch let error as LuxTtsError {
            guard case .inputTooLong = error, depth < 6 else { throw error }
            // Clause boundaries first: the budget is in tokens, which characters
            // do not predict, so aim only at making the piece smaller rather
            // than at a character target. Halving on characters cuts between
            // words and is audible as a pause mid-phrase.
            var pieces = splitAtClauseBoundaries(text)
            if pieces.count < 2 {
                pieces = splitAtWordBoundaries(text, maxCharacters: max(20, text.count / 2))
            }
            guard pieces.count > 1 else { throw error }
            var samples: [Float] = []
            for piece in pieces {
                samples.append(
                    contentsOf: try await synthesizeFitting(
                        piece, ref: ref, refText: refText, speed: speed, seed: seed,
                    depth: depth + 1))
            }
            return samples
        }
    }
}

// MARK: - NeuTTS-2E

actor NeuTtsDriver: TtsBackendDriver {
    static let id = "neutts-2e"
    // Four fixed speakers × seven emotions. Not the zero-shot cloning model
    // `neutts-air` on the mlx-audio side, despite the shared family name.
    static let supportsCloning = false
    static let sampleRate = 24000

    private let manager: NeuTtsManager

    init(modelsDirectory: URL?) async throws {
        manager = NeuTtsManager()
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        let audio = try await manager.synthesize(
            text: request.text,
            speaker: request.voice ?? NeuTtsConstants.defaultSpeaker,
            emotion: request.emotion ?? NeuTtsConstants.defaultEmotion,
            temperature: request.temperature ?? NeuTtsConstants.temperature,
            topK: request.topK ?? NeuTtsConstants.topK,
            seed: request.seed ?? UInt64.random(in: 0..<UInt64.max))
        return SynthesisResult(samples: audio.samples, sampleRate: audio.sampleRate)
    }
}

// MARK: - Chatterbox Multilingual

actor ChatterboxDriver: TtsBackendDriver {
    static let id = "chatterbox"
    // FluidAudio's conversion exposes no reference-audio path: `synthesize`
    // takes text, language and sampling params only. The mlx-audio arm clones;
    // this one cannot, so the two are not voice-for-voice comparable.
    static let supportsCloning = false
    static let sampleRate = 24000

    private let manager: ChatterboxManager

    init(modelsDirectory: URL?) async throws {
        manager = ChatterboxManager()
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        // Text shares the T3 prefill window with the voice conditioning, so a
        // long text throws `textTooLong`. Chunk and concatenate, as for the
        // other capped backends.
        var samples: [Float] = []
        var rate = Self.sampleRate
        for chunk in splitIntoChunks(request.text, maxCharacters: 150) {
            let audio = try await manager.synthesize(
                text: chunk,
                language: request.language ?? ChatterboxConstants.defaultLanguage,
                cfgWeight: request.cfgWeight ?? ChatterboxConstants.cfgWeight,
                temperature: request.temperature ?? ChatterboxConstants.temperature,
                repetitionPenalty: request.repetitionPenalty
                    ?? ChatterboxConstants.repetitionPenalty,
                minP: request.minP ?? ChatterboxConstants.minP,
                topP: request.topP ?? ChatterboxConstants.topP,
                seed: request.seed ?? UInt64.random(in: 0..<UInt64.max))
            samples.append(contentsOf: audio.samples)
            rate = audio.sampleRate
        }
        return SynthesisResult(samples: samples, sampleRate: rate)
    }
}

// MARK: - Inflect

actor InflectDriver: TtsBackendDriver {
    static let id = "inflect-micro"
    static let supportsCloning = false
    static let sampleRate = 24000

    private var manager: InflectManager
    private let modelsDirectory: URL?
    private let variant: InflectVariant
    private var currentNoiseScale: Float
    private var currentSpeed: Float

    init(modelsDirectory: URL?) async throws {
        try await self.init(modelsDirectory: modelsDirectory, variant: .micro)
    }

    init(modelsDirectory: URL?, variant: InflectVariant) async throws {
        self.modelsDirectory = modelsDirectory
        self.variant = variant
        currentNoiseScale = InflectConstants.defaultNoiseScale
        currentSpeed = InflectConstants.defaultSpeed
        manager = InflectManager(
            variant: variant, directory: modelsDirectory,
            noiseScale: currentNoiseScale, speed: currentSpeed)
    }

    func load() async throws {
        try await manager.initialize()
    }

    func synthesize(_ request: SynthesisRequest) async throws -> SynthesisResult {
        // Inflect takes noiseScale and speed on `init`, not on `synthesize`, so
        // a request that changes either needs a new manager and a reload.
        let wantNoise = request.noiseScale ?? InflectConstants.defaultNoiseScale
        let wantSpeed = request.speed ?? InflectConstants.defaultSpeed
        if wantNoise != currentNoiseScale || wantSpeed != currentSpeed {
            manager = InflectManager(
                variant: variant, directory: modelsDirectory,
                noiseScale: wantNoise, speed: wantSpeed)
            try await manager.initialize()
            currentNoiseScale = wantNoise
            currentSpeed = wantSpeed
        }
        let samples = try await manager.synthesize(
            text: request.text, noiseSeed: request.seed ?? 0)
        return SynthesisResult(samples: samples, sampleRate: Self.sampleRate)
    }
}
