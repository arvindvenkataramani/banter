import Foundation

/// Deepgram's message shapes, built from the model's transcript and word
/// timings. Confidence is not produced by the models and is reported as 1.0.
enum DeepgramResults {
    /// A streaming `Results` message. `offset` is where the utterance's clock
    /// starts in the stream, in seconds; word times arrive relative to it.
    static func streamResult(
        text: String, words: [WordTiming], offset: Double, duration: Double,
        isFinal: Bool, speechFinal: Bool, fromFinalize: Bool, channels: Int,
        model: String, requestId: String
    ) -> String {
        let message: [String: Any] = [
            "type": "Results",
            "start": offset,
            "duration": duration,
            "is_final": isFinal,
            "speech_final": speechFinal,
            "from_finalize": fromFinalize,
            "channel": alternatives(text: text, words: words, offset: offset),
            "metadata": [
                "request_id": requestId,
                "model_info": modelInfo(model),
                "model_uuid": UUID().uuidString,
            ] as [String: Any],
            "channel_index": [0, channels],
        ]
        return encode(message)
    }

    /// The `Metadata` message Deepgram sends as a stream closes.
    static func streamClosed(duration: Double, channels: Int, requestId: String) -> String {
        encode([
            "type": "Metadata", "request_id": requestId,
            "created": ISO8601DateFormatter().string(from: Date()),
            "duration": duration, "channels": channels,
        ])
    }

    static func batchResponse(
        text: String, words: [WordTiming], duration: Double, channels: Int,
        model: String, requestId: String
    ) -> Data {
        let message: [String: Any] = [
            "metadata": [
                "request_id": requestId,
                "created": ISO8601DateFormatter().string(from: Date()),
                "duration": duration,
                "channels": channels,
                "model_info": modelInfo(model),
            ] as [String: Any],
            "results": ["channels": [alternatives(text: text, words: words, offset: 0)]],
        ]
        return Data(encode(message).utf8)
    }

    private static func modelInfo(_ model: String) -> [String: Any] {
        ["name": model, "version": "", "arch": ""]
    }

    private static func alternatives(text: String, words: [WordTiming], offset: Double) -> [String: Any] {
        let mapped: [[String: Any]] = words.map { w in
            [
                "word": bare(w.word),
                "punctuated_word": w.word,
                "start": w.start + offset,
                "end": w.end + offset,
                "confidence": 1.0,
            ]
        }
        return ["alternatives": [["transcript": text, "confidence": 1.0, "words": mapped]]]
    }

    /// Lowercase, without edge punctuation: Deepgram's `word` against its
    /// `punctuated_word`.
    private static func bare(_ word: String) -> String {
        word.lowercased().trimmingCharacters(in: .punctuationCharacters)
    }

    private static func encode(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        return String(decoding: data, as: UTF8.self)
    }
}
