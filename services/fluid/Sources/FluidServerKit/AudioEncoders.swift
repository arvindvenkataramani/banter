import AudioToolbox
import AVFoundation
import Foundation

/// An encoder that could not be created or could not run.
///
/// The kit's own error rather than a server's: an encoder knows nothing about
/// synthesis or transcription, and a caller maps this onto whatever vocabulary
/// its own API speaks.
public enum AudioEncodingError: Error, CustomStringConvertible, Sendable {
    case unsupported(String)

    public var description: String {
        switch self {
        case .unsupported(let message): return message
        }
    }
}

/// What a caller can ask for in `response_format`.
///
/// AAC is the default because it is what both ends of the platform speak: the
/// dashboard plays it through MediaSource, and Android has decoded AAC-LC for
/// as long as it has existed. WAV is the floor beneath it — anything that
/// cannot decode AAC can still play WAV, losing the MediaSource path but not
/// the audio.
public enum AudioFormat: String, Sendable {
    case aac
    case wav

    /// Returns nil for a format the server cannot produce, so the route can
    /// refuse it. Serving WAV to a caller that asked for something else is
    /// what turns an unplayable stream into a silent success.
    public init?(requested: String?) {
        guard let requested, !requested.isEmpty else {
            self = .aac
            return
        }
        guard let format = AudioFormat(rawValue: requested.lowercased()) else { return nil }
        self = format
    }

    public var contentType: String {
        switch self {
        case .aac: return "audio/aac"
        case .wav: return "audio/wav"
        }
    }
}

/// Encodes one response.
///
/// The contract is a single container for the whole response: `encode` may emit
/// a header the first time and audio thereafter, and `finish` flushes whatever
/// the encoder is still holding. A container per interval would repeat the
/// header at every seam — and for a codec with encoder delay and end padding,
/// put a gap there too.
public protocol StreamingAudioEncoder: AnyObject {
    func encode(_ samples: [Float]) throws -> Data
    func finish() throws -> Data
}

public func makeEncoder(format: AudioFormat, sampleRate: Int) throws -> any StreamingAudioEncoder {
    switch format {
    case .wav: return WavStreamEncoder(sampleRate: sampleRate)
    case .aac: return try AacStreamEncoder(sampleRate: sampleRate)
    }
}

/// 16-bit PCM behind one RIFF header.
public final class WavStreamEncoder: StreamingAudioEncoder {
    private let sampleRate: Int
    private var wroteHeader = false

    public init(sampleRate: Int) {
        self.sampleRate = sampleRate
    }

    public func encode(_ samples: [Float]) throws -> Data {
        var out = Data()
        if !wroteHeader {
            out.append(Self.header(sampleRate: sampleRate))
            wroteHeader = true
        }
        out.append(Self.pcm(samples))
        return out
    }

    public func finish() throws -> Data {
        // Nothing is buffered, but a response that generated no audio still
        // owes a caller a parseable file.
        if !wroteHeader {
            wroteHeader = true
            return Self.header(sampleRate: sampleRate)
        }
        return Data()
    }

    /// The length is unknown when this goes out, so the size fields carry
    /// `0xFFFFFFFF` — the convention a streaming WAV writer uses when it cannot
    /// seek back to fill them in. Players read to the end of the connection.
    static func header(sampleRate: Int) -> Data {
        var data = Data()
        func le32(_ v: UInt32) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }
        func le16(_ v: UInt16) -> Data { withUnsafeBytes(of: v.littleEndian) { Data($0) } }

        data.append("RIFF".data(using: .ascii)!)
        data.append(le32(UInt32.max))
        data.append("WAVE".data(using: .ascii)!)
        data.append("fmt ".data(using: .ascii)!)
        data.append(le32(16))
        data.append(le16(1))  // PCM
        data.append(le16(1))  // mono
        data.append(le32(UInt32(sampleRate)))
        data.append(le32(UInt32(sampleRate * 2)))
        data.append(le16(2))
        data.append(le16(16))
        data.append("data".data(using: .ascii)!)
        data.append(le32(UInt32.max))
        return data
    }

    static func pcm(_ samples: [Float]) -> Data {
        var pcm = Data(capacity: samples.count * 2)
        for s in samples {
            let clamped = max(-1.0, min(1.0, s))
            let v = Int16(clamped * 32767.0)
            pcm.append(contentsOf: withUnsafeBytes(of: v.littleEndian) { Array($0) })
        }
        return pcm
    }
}

/// AAC-LC in ADTS, through AudioToolbox.
///
/// ADTS rather than a file container: each frame carries its own header and
/// length, so frames concatenate into a stream a player can join without
/// seeking. That is what lets a response be one stream while still arriving in
/// pieces.
public final class AacStreamEncoder: StreamingAudioEncoder {
    private var converter: AudioConverterRef?
    private let sampleRate: Int
    /// AAC-LC consumes exactly this many frames per packet; the converter pulls
    /// until it has them, so leftovers wait here for the next call.
    private static let framesPerPacket = 1024
    private var pending: [Int16] = []
    private var outputBuffer: [UInt8]
    /// Set while `fill` is draining `pending`, read by the input callback.
    private var feedIndex = 0
    private var feedSamples: [Int16] = []

    public init(sampleRate: Int) throws {
        self.sampleRate = sampleRate
        self.outputBuffer = [UInt8](repeating: 0, count: 2048)

        var input = AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
            mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var output = AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate), mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0, mBytesPerPacket: 0,
            mFramesPerPacket: UInt32(Self.framesPerPacket),
            mBytesPerFrame: 0, mChannelsPerFrame: 1, mBitsPerChannel: 0, mReserved: 0)

        var converter: AudioConverterRef?
        let status = AudioConverterNew(&input, &output, &converter)
        guard status == noErr, let converter else {
            throw AudioEncodingError.unsupported("could not open an AAC encoder: OSStatus \(status)")
        }
        self.converter = converter
    }

    deinit {
        if let converter { AudioConverterDispose(converter) }
    }

    public func encode(_ samples: [Float]) throws -> Data {
        pending.append(
            contentsOf: samples.map { Int16(max(-1.0, min(1.0, $0)) * 32767.0) })
        return try drain(flushing: false)
    }

    /// Encodes what is left, padding the final packet with silence.
    ///
    /// AAC works in whole packets, so a tail shorter than one would otherwise be
    /// dropped — the last fraction of a second of every utterance.
    public func finish() throws -> Data {
        guard !pending.isEmpty else { return Data() }
        let shortfall = Self.framesPerPacket - (pending.count % Self.framesPerPacket)
        if shortfall != Self.framesPerPacket {
            pending.append(contentsOf: [Int16](repeating: 0, count: shortfall))
        }
        return try drain(flushing: true)
    }

    /// Pulls packets until the converter has consumed everything staged.
    ///
    /// The whole of `pending` is made available to the input callback rather
    /// than one packet at a time: the converter decides how much it wants, and
    /// a callback that reports exhaustion after a single packet makes it stop
    /// early — which silently truncates an utterance to its first fraction of
    /// a second. Whatever the converter did not take stays buffered for the
    /// next call.
    private func drain(flushing: Bool) throws -> Data {
        guard let converter else { return Data() }
        guard pending.count >= Self.framesPerPacket || flushing else { return Data() }

        feedSamples = pending
        feedIndex = 0
        var out = Data()

        while true {
            var packetCount: UInt32 = 1
            var packetDescription = AudioStreamPacketDescription()
            var bufferList = AudioBufferList(
                mNumberBuffers: 1,
                mBuffers: AudioBuffer(
                    mNumberChannels: 1, mDataByteSize: UInt32(outputBuffer.count),
                    mData: nil))

            let status = outputBuffer.withUnsafeMutableBytes { raw -> OSStatus in
                bufferList.mBuffers.mData = raw.baseAddress
                return AudioConverterFillComplexBuffer(
                    converter, Self.inputProc, Unmanaged.passUnretained(self).toOpaque(),
                    &packetCount, &bufferList, &packetDescription)
            }
            guard status == noErr || status == Self.kNoMoreDataError else {
                throw AudioEncodingError.unsupported("AAC encode failed: OSStatus \(status)")
            }
            guard packetCount > 0 else { break }

            let payload = Int(packetDescription.mDataByteSize)
            if payload > 0 {
                out.append(Self.adtsHeader(payloadBytes: payload, sampleRate: sampleRate))
                out.append(contentsOf: outputBuffer[0..<payload])
            }
            if status == Self.kNoMoreDataError { break }
        }

        // Keep the remainder the converter has not read yet.
        pending = feedIndex < feedSamples.count ? Array(feedSamples[feedIndex...]) : []
        feedSamples = []
        feedIndex = 0
        return out
    }

    /// What the input callback returns when it has nothing left; the converter
    /// passes it back out of `FillComplexBuffer` alongside the final packet.
    private static let kNoMoreDataError: OSStatus = 1

    /// Hands the converter the packet `drain` staged. Returning zero frames
    /// tells it to emit what it has rather than wait for more.
    private static let inputProc: AudioConverterComplexInputDataProc = {
        _, ioNumberDataPackets, ioData, _, userData in
        guard let userData else {
            ioNumberDataPackets.pointee = 0
            return noErr
        }
        let encoder = Unmanaged<AacStreamEncoder>.fromOpaque(userData).takeUnretainedValue()
        let remaining = encoder.feedSamples.count - encoder.feedIndex
        guard remaining > 0 else {
            // Signalled rather than returning noErr with zero packets: that
            // pair reads as "nothing yet, ask again" and spins.
            ioNumberDataPackets.pointee = 0
            return kNoMoreDataError
        }
        let count = min(Int(ioNumberDataPackets.pointee), remaining)
        encoder.feedSamples.withUnsafeMutableBufferPointer { buffer in
            ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(
                buffer.baseAddress! + encoder.feedIndex)
        }
        ioData.pointee.mBuffers.mDataByteSize = UInt32(count * 2)
        ioData.pointee.mBuffers.mNumberChannels = 1
        ioData.pointee.mNumberBuffers = 1
        encoder.feedIndex += count
        ioNumberDataPackets.pointee = UInt32(count)
        return noErr
    }

    /// The 7-byte ADTS header that makes a raw AAC packet self-delimiting.
    static func adtsHeader(payloadBytes: Int, sampleRate: Int) -> Data {
        let total = payloadBytes + 7
        let profile = 1  // AAC-LC, encoded as profile - 1
        let channels = 1
        let index = samplingFrequencyIndex(sampleRate)

        var header = [UInt8](repeating: 0, count: 7)
        header[0] = 0xFF
        // Sync word's low nibble, MPEG-4, layer 0, no CRC.
        header[1] = 0xF1
        header[2] = UInt8((profile << 6) | (index << 2) | ((channels >> 2) & 0x01))
        header[3] = UInt8(((channels & 0x03) << 6) | ((total >> 11) & 0x03))
        header[4] = UInt8((total >> 3) & 0xFF)
        header[5] = UInt8(((total & 0x07) << 5) | 0x1F)
        header[6] = 0xFC
        return Data(header)
    }

    static func samplingFrequencyIndex(_ rate: Int) -> Int {
        let table = [
            96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
            7350,
        ]
        return table.firstIndex(of: rate) ?? 6  // 24 kHz, what the models produce
    }
}
