import AVFoundation
import Foundation

/// Regroup a driver's frames into fixed-duration chunks.
///
/// A driver yields on whatever boundary its decoder produces, which is neither
/// a useful playback unit nor a stable one across backends. Accumulating to a
/// *time* interval is what bounds TTFB: a caller waits at most one interval for
/// audio however long the text is, where a sentence or frame-count boundary
/// would stretch with it.
///
/// The tail is flushed however short it is — the last emission of an utterance
/// is almost never a whole interval, and dropping it would clip every response.
func bufferedChunks(
    _ frames: AsyncThrowingStream<[Float], Error>, interval: Double, sampleRate: Int
) -> AsyncThrowingStream<[Float], Error> {
    // A zero or negative interval would divide the stream into nothing. One
    // sample per emission is the smallest honest reading of "as fast as
    // possible", and it keeps the sweep's lower end usable.
    let target = max(1, Int(interval * Double(sampleRate)))

    return AsyncThrowingStream { continuation in
        Task {
            var buffer: [Float] = []
            buffer.reserveCapacity(target)
            do {
                for try await frame in frames {
                    buffer.append(contentsOf: frame)
                    // A frame can be several intervals long, so this drains
                    // rather than emitting once per frame.
                    while buffer.count >= target {
                        continuation.yield(Array(buffer.prefix(target)))
                        buffer.removeFirst(target)
                    }
                }
                if !buffer.isEmpty { continuation.yield(buffer) }
                continuation.finish()
            } catch {
                // Whatever was buffered when the producer failed is still real
                // audio; the caller keeps what arrived and learns it truncated.
                continuation.finish(throwing: error)
            }
        }
    }
}

/// Some managers return WAV `Data` rather than samples; unwrap it so every
/// backend reaches the HTTP layer as samples.
func decodeWavSamples(_ wav: Data) throws -> [Float] {
    guard wav.count > 44 else { return [] }
    // Locate the data chunk rather than assuming a 44-byte header: a manager
    // that writes a LIST or fact chunk would otherwise shift every sample.
    var offset = 12
    var dataRange: Range<Int>? = nil
    while offset + 8 <= wav.count {
        let id = String(bytes: wav[offset..<offset + 4], encoding: .ascii) ?? ""
        let size = wav.withUnsafeBytes { raw -> UInt32 in
            raw.loadUnaligned(fromByteOffset: offset + 4, as: UInt32.self).littleEndian
        }
        let body = offset + 8
        if id == "data" {
            dataRange = body..<min(body + Int(size), wav.count)
            break
        }
        offset = body + Int(size) + (Int(size) % 2)
    }
    guard let range = dataRange else { return [] }
    let bytes = wav.subdata(in: range)
    var samples = [Float]()
    samples.reserveCapacity(bytes.count / 2)
    bytes.withUnsafeBytes { raw in
        for i in stride(from: 0, to: bytes.count - 1, by: 2) {
            let v = raw.loadUnaligned(fromByteOffset: i, as: Int16.self).littleEndian
            samples.append(Float(v) / 32768.0)
        }
    }
    return samples
}

/// StyleTTS2's reference encoder is a fixed-shape CoreML model: it accepts
/// exactly one mel-frame count and rejects anything else, so a whole reference
/// clip always fails. Trimming belongs here rather than in each caller.
enum StyleTts2ReferenceTrim {
    /// The shape the converted `ref_encoder` declares. A clip yielding any other
    /// frame count throws `MultiArray shape … does not match`.
    static let requiredMelFrames = 231
    static let sampleRate = 24000
    /// Hop inferred from the model: 3.000 s gave 241 frames and 2.875 s gives
    /// 231, i.e. 300 samples per frame at 24 kHz.
    static let hopSize = 300

    static var durationSeconds: Double {
        Double((requiredMelFrames - 1) * hopSize) / Double(sampleRate)
    }

    /// Returns a temporary 24 kHz mono clip of exactly the required length.
    /// Caller deletes it.
    static func trim(_ source: URL) throws -> URL {
        let file = try AVAudioFile(forReading: source)
        guard
            let outFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate),
                channels: 1, interleaved: false)
        else {
            throw TtsError.unsupported("could not build 24 kHz mono format")
        }

        let wanted = AVAudioFrameCount((requiredMelFrames - 1) * hopSize)
        let converter = AVAudioConverter(from: file.processingFormat, to: outFormat)
        guard let converter else {
            throw TtsError.unsupported("could not convert reference audio to 24 kHz mono")
        }

        guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: wanted) else {
            throw TtsError.unsupported("could not allocate reference buffer")
        }

        var finished = false
        var conversionError: NSError? = nil
        let status = converter.convert(to: out, error: &conversionError) { need, outStatus in
            if finished {
                outStatus.pointee = .endOfStream
                return nil
            }
            guard
                let input = AVAudioPCMBuffer(
                    pcmFormat: file.processingFormat, frameCapacity: need)
            else {
                outStatus.pointee = .endOfStream
                return nil
            }
            do {
                try file.read(into: input, frameCount: need)
            } catch {
                outStatus.pointee = .endOfStream
                return nil
            }
            if input.frameLength == 0 {
                finished = true
                outStatus.pointee = .endOfStream
                return nil
            }
            outStatus.pointee = .haveData
            return input
        }
        if status == .error, let conversionError { throw conversionError }

        guard out.frameLength >= wanted else {
            throw TtsError.unsupported(
                "reference audio is shorter than the \(String(format: "%.3f", durationSeconds))s "
                    + "StyleTTS2 requires")
        }
        out.frameLength = wanted

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("st2-ref-\(UUID().uuidString).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: Double(sampleRate),
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let outFile = try AVAudioFile(forWriting: url, settings: settings)
        try outFile.write(from: out)
        return url
    }
}
