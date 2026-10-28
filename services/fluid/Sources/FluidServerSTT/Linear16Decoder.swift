import Foundation

/// Little-endian Int16 at the client's declared rate and channel count, turned
/// into the 16 kHz mono floats the managers consume. Channels are averaged, so
/// a two-channel call is transcribed as one mixed stream.
///
/// Holds the bytes of a sample cut across two frames, and the resampler's
/// position, so one instance belongs to one connection.
final class Linear16Decoder {
    private static let targetRate = 16000
    private let channels: Int
    private let step: Double
    private var carry: [UInt8] = []
    private var pending: [Float] = []
    private var position = 0.0

    init(sampleRate: Int, channels: Int) {
        self.channels = max(1, channels)
        self.step = Double(sampleRate) / Double(Self.targetRate)
    }

    func decode(_ bytes: [UInt8]) -> [Float] {
        var data = carry + bytes
        let frameBytes = 2 * channels
        let usable = data.count - data.count % frameBytes
        carry = Array(data[usable...])
        data = Array(data[..<usable])

        var mono = [Float]()
        mono.reserveCapacity(usable / frameBytes)
        for frame in stride(from: 0, to: usable, by: frameBytes) {
            var sum: Float = 0
            for channel in 0..<channels {
                let i = frame + channel * 2
                sum += Float(Int16(bitPattern: UInt16(data[i]) | UInt16(data[i + 1]) << 8)) / 32768.0
            }
            mono.append(sum / Float(channels))
        }
        if step == 1.0 { return mono }
        return resample(mono)
    }

    /// Linear interpolation, carrying the fractional position between calls so
    /// frame boundaries do not add or drop samples.
    private func resample(_ input: [Float]) -> [Float] {
        pending += input
        var out = [Float]()
        while Int(position) + 1 < pending.count {
            let i = Int(position)
            let frac = Float(position - Double(i))
            out.append(pending[i] * (1 - frac) + pending[i + 1] * frac)
            position += step
        }
        let consumed = min(Int(position), pending.count)
        pending.removeFirst(consumed)
        position -= Double(consumed)
        return out
    }
}
