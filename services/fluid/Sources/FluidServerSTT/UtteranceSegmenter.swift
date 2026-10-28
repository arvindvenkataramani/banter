import Foundation

/// Decides where an utterance ends in a stream whose client does not say.
///
/// An energy gate over 10 ms windows of 16 kHz audio: a pause of
/// `endpointingMs` after speech closes the utterance. Silence before any speech
/// never closes anything. The 0.01 RMS threshold (about -40 dBFS) is a starting
/// value, not a measurement.
struct UtteranceSegmenter {
    private static let window = 160
    private static let speechRMS: Float = 0.01

    private let silenceWindowsToEnd: Int
    private var heardSpeech = false
    private var silentWindows = 0
    private var leftover: [Float] = []

    init(endpointingMs: Int) {
        silenceWindowsToEnd = max(1, endpointingMs / 10)
    }

    /// True when this audio completed a pause after speech.
    mutating func feed(_ samples: [Float]) -> Bool {
        let all = leftover + samples
        let usable = all.count - all.count % Self.window
        leftover = Array(all[usable...])
        var ended = false
        for start in stride(from: 0, to: usable, by: Self.window) {
            var energy: Float = 0
            for i in start..<(start + Self.window) { energy += all[i] * all[i] }
            if (energy / Float(Self.window)).squareRoot() >= Self.speechRMS {
                heardSpeech = true
                silentWindows = 0
            } else if heardSpeech {
                silentWindows += 1
                if silentWindows >= silenceWindowsToEnd {
                    ended = true
                    heardSpeech = false
                    silentWindows = 0
                }
            }
        }
        return ended
    }
}
