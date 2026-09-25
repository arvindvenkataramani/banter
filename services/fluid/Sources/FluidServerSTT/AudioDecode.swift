import COpus
import Foundation

/// How a client is sending audio. Declared once, on connect.
enum AudioFormat: String, Sendable {
    /// Raw little-endian Int16, 16 kHz mono. No dependencies; the fallback.
    case pcm16
    /// Raw Opus packets, one per frame, as WebCodecs `AudioEncoder` produces
    /// them. Not the WebM that `MediaRecorder` emits — there is no container
    /// here, so packets decode directly.
    case opus
}

/// Turns wire frames into the 16 kHz mono float samples the managers consume.
///
/// Opus carries a decoder's worth of state across packets, so an instance
/// belongs to one connection and must not be shared.
final class AudioDecoder {
    private let format: AudioFormat
    private var opus: OpaquePointer?

    /// Opus packets are at most 120 ms; at 16 kHz that is 1920 samples. Sized
    /// to the largest legal frame so a decode never truncates.
    private static let maxFrameSamples = 1920

    init(format: AudioFormat) throws {
        self.format = format
        if format == .opus {
            var error: Int32 = 0
            opus = opus_decoder_create(16000, 1, &error)
            guard error == OPUS_OK, opus != nil else {
                throw FluidServerSTTError.decoderFailed("opus_decoder_create: \(error)")
            }
        }
    }

    deinit {
        if let opus { opus_decoder_destroy(opus) }
    }

    func decode(_ bytes: [UInt8]) throws -> [Float] {
        switch format {
        case .pcm16:
            // Two bytes per sample, little-endian, as a browser's Int16Array
            // serialises. A trailing odd byte would mean a split sample, which
            // the framing does not produce.
            var out = [Float]()
            out.reserveCapacity(bytes.count / 2)
            for i in stride(from: 0, to: bytes.count - 1, by: 2) {
                let raw = Int16(bitPattern: UInt16(bytes[i]) | UInt16(bytes[i + 1]) << 8)
                out.append(Float(raw) / 32768.0)
            }
            return out

        case .opus:
            guard let opus else { throw FluidServerSTTError.decoderFailed("decoder gone") }
            var out = [Float](repeating: 0, count: Self.maxFrameSamples)
            let decoded = bytes.withUnsafeBufferPointer { src in
                out.withUnsafeMutableBufferPointer { dst in
                    guard let dstBase = dst.baseAddress else { return Int32(-1) }
                    return opus_decode_float(
                        opus, src.baseAddress, Int32(bytes.count),
                        dstBase, Int32(Self.maxFrameSamples), 0)
                }
            }
            guard decoded > 0 else {
                throw FluidServerSTTError.decoderFailed("opus_decode_float: \(decoded)")
            }
            return Array(out[0..<Int(decoded)])
        }
    }
}
