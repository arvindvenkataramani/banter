import AVFoundation
import FluidAudio
import Foundation

/// What a streaming manager emits as audio arrives.
enum StreamEvent: Sendable {
    case partial(String)
    case final(text: String, words: [WordTiming])
}

/// A live streaming-ASR session over one of the session-API managers.
///
/// The two managers differ in how timings come out: Unified drains them
/// incrementally and would lose them if never drained, while Nemotron
/// accumulates and hands them over at `finish()`. Both are hidden behind
/// `append` / `partial` / `finish` so a connection handler never learns which
/// it is talking to.
enum StreamingSession {
    case unified(StreamingUnifiedAsrManager)
    case nemotron(StreamingNemotronAsrManager)

    /// Feed one buffer of 16 kHz mono float samples and process whatever whole
    /// chunks it completes. The updated transcript is read separately via
    /// `partial()`; a caller comparing successive reads is what sends on
    /// change rather than on every frame.
    func append(samples: [Float]) async throws {
        let buffer = try makeBuffer(samples)
        switch self {
        case .unified(let manager):
            try await manager.appendAudio(buffer)
            try await manager.processBufferedAudio()
        case .nemotron(let manager):
            _ = try await manager.process(audioBuffer: buffer)
        }
    }

    func partial() async -> String {
        switch self {
        case .unified(let manager): return await manager.getPartialTranscript()
        case .nemotron(let manager): return await manager.getPartialTranscript()
        }
    }

    /// Flush and return the final transcript with word timings.
    func finish() async throws -> (text: String, words: [WordTiming]) {
        switch self {
        case .unified(let manager):
            let text = try await manager.finish()
            // Unified's own word grouping applies the same boundary rule as
            // WordTimings.swift; its shape differs, so convert rather than
            // regroup.
            let words = await manager.consumeWordTimings().map {
                WordTiming(word: $0.word, start: $0.startTime, end: $0.endTime)
            }
            return (text, words)

        case .nemotron(let manager):
            let result = try await manager.finishWithTokenTimings()
            return (result.text, mergeTokensIntoWords(result.timings))
        }
    }

    /// Clear the decoder and encoder state so the next utterance starts clean,
    /// without tearing the session down.
    ///
    /// This is what lets one connection carry a whole conversation: `finish()`
    /// returns the transcript, `reset()` readies the manager for the next turn,
    /// and the model stays loaded between them.
    func reset() async throws {
        switch self {
        case .unified(let manager): try await manager.reset()
        case .nemotron(let manager): await manager.reset()
        }
    }

    /// Always called when a connection ends, however it ends.
    func close() async {
        switch self {
        case .unified(let manager): await manager.cleanup()
        case .nemotron(let manager): await manager.cleanup()
        }
    }

    private func makeBuffer(_ samples: [Float]) throws -> AVAudioPCMBuffer {
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false),
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))
        else {
            throw FluidServerSTTError.badAudioFrame
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { src in
            buffer.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
        }
        return buffer
    }
}
