import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore

/// OpenAI Realtime at `/v1/realtime`, as a transcription session: each commit is
/// transcribed whole, in order. Any client event outside the subset is an `error`.
func registerRealtimeTranscription(on wsRouter: Router<BasicWebSocketRequestContext>, ctx: AppContext) {
    wsRouter.ws("/v1/realtime") { inbound, outbound, wsCtx in
        let params = queryDictionary(wsCtx.request.uri.queryParameters)
        let session = RealtimeTranscription(ctx: ctx, outbound: outbound, model: params["model"])
        if let intent = params["intent"], intent != "transcription" {
            await session.error("unsupported_intent", "only intent=transcription is served here")
            try? await outbound.close(.policyViolation, reason: "unsupported intent")
            return
        }
        await session.created()
        for try await frame in inbound.messages(maxSize: 8 * 1024 * 1024) {
            guard case .text(let string) = frame else {
                await session.error("invalid_event", "client events are JSON text messages")
                continue
            }
            await session.handle(string)
        }
    }
}

/// One Realtime transcription connection's state.
private actor RealtimeTranscription {
    private enum InputFormat: String { case pcm = "audio/pcm", opus = "audio/opus" }

    private let ctx: AppContext
    private let outbound: WebSocketOutboundWriter
    private let sessionId = "sess_\(RealtimeTranscription.shortId())"
    /// The serving's key the session transcribes with; nil uses the resident model.
    private var model: String?
    private var format = InputFormat.pcm
    private var rate = 24000
    private var linear16 = Linear16Decoder(sampleRate: 24000, channels: 1)
    private var opus: AudioDecoder?
    private var buffer: [Float] = []
    private var previousItem: String?

    init(ctx: AppContext, outbound: WebSocketOutboundWriter, model: String?) {
        self.ctx = ctx
        self.outbound = outbound
        self.model = model
    }

    static func shortId() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(20))
    }

    func created() async {
        await send(["type": "session.created", "session": sessionObject()])
    }

    func handle(_ text: String) async {
        guard let data = text.data(using: .utf8),
            let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
            let type = event["type"] as? String
        else {
            return await error("invalid_event", "the message is not a JSON object with a type")
        }
        let eventId = event["event_id"] as? String
        switch type {
        case "session.update":
            await update(event["session"] as? [String: Any] ?? [:], eventId: eventId)
        case "input_audio_buffer.append":
            await append(event["audio"] as? String, eventId: eventId)
        case "input_audio_buffer.commit":
            await commit(eventId: eventId)
        case "input_audio_buffer.clear":
            buffer.removeAll()
            await send(["type": "input_audio_buffer.cleared"])
        default:
            await error("unsupported_event", "\(type) is not served; this is a transcription session", eventId)
        }
    }

    private func update(_ session: [String: Any], eventId: String?) async {
        if let type = session["type"] as? String, type != "transcription" {
            return await error("unsupported_session", "only a transcription session is served", eventId)
        }
        let input = (session["audio"] as? [String: Any])?["input"] as? [String: Any] ?? [:]
        if let turn = input["turn_detection"], !(turn is NSNull) {
            return await error(
                "unsupported_turn_detection", "turn_detection must be null; the client commits each turn", eventId)
        }
        if let requested = input["format"] as? [String: Any] {
            guard let name = requested["type"] as? String, let kind = InputFormat(rawValue: name) else {
                return await error(
                    "unsupported_format", "audio.input.format must be audio/pcm or audio/opus", eventId)
            }
            switch kind {
            case .pcm:
                rate = (requested["rate"] as? Int) ?? 24000
                linear16 = Linear16Decoder(sampleRate: rate, channels: 1)
            case .opus:
                rate = (requested["rate"] as? Int) ?? 48000
                do {
                    opus = try AudioDecoder(format: .opus)
                } catch {
                    return await self.error("decoder_failed", "\(error)", eventId)
                }
            }
            format = kind
            buffer.removeAll()
        }
        if let named = (input["transcription"] as? [String: Any])?["model"] as? String {
            model = named
        }
        await send(["type": "session.updated", "session": sessionObject()])
    }

    private func append(_ audio: String?, eventId: String?) async {
        guard let audio, let bytes = Data(base64Encoded: audio) else {
            return await error("invalid_audio", "audio must be base64", eventId)
        }
        do {
            switch format {
            case .pcm: buffer += linear16.decode(Array(bytes))
            case .opus: buffer += try opus?.decode(Array(bytes)) ?? []
            }
        } catch {
            await self.error("invalid_audio", "\(error)", eventId)
        }
    }

    private func commit(eventId: String?) async {
        guard !buffer.isEmpty else {
            return await error(
                "input_audio_buffer_commit_empty", "nothing has been appended since the last commit", eventId)
        }
        let samples = buffer
        buffer.removeAll()
        let item = "item_\(Self.shortId())"
        await send([
            "type": "input_audio_buffer.committed", "item_id": item,
            "previous_item_id": previousItem.map { $0 as Any } ?? NSNull(),
        ])
        previousItem = item
        do {
            let text = try await transcribe(samples)
            let seconds = Double(samples.count) / 16000
            if !text.isEmpty {
                await send([
                    "type": "conversation.item.input_audio_transcription.delta", "item_id": item,
                    "content_index": 0, "delta": text,
                ])
            }
            await send([
                "type": "conversation.item.input_audio_transcription.completed", "item_id": item,
                "content_index": 0, "transcript": text,
                "usage": ["type": "duration", "seconds": seconds] as [String: Any],
            ])
        } catch {
            let message = (error as? any FluidServerError)?.description ?? "\(error)"
            await self.error("transcription_failed", message, eventId)
        }
    }

    /// One turn, through the batch path, or through a session for a model that only streams.
    private func transcribe(_ samples: [Float]) async throws -> String {
        let expecting = try model.map { try ctx.resident.roster.id(forKey: $0) }
        var pcm = Data(capacity: samples.count * 2)
        for sample in samples {
            let value = Int16(max(-1, min(1, sample)) * 32767)
            withUnsafeBytes(of: value.littleEndian) { pcm.append(contentsOf: $0) }
        }
        let url = ctx.temporaryDirectory.appendingPathComponent("fluidserver-\(UUID().uuidString).wav")
        try wavFile(pcm16: pcm, sampleRate: 16000, channels: 1).write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            return try await ctx.resident.transcribe(url: url, expecting: expecting).text
        } catch FluidServerSTTError.streamingModelSelected {
            let begun = try await ctx.resident.beginSession(expecting: expecting, session: nil)
            do {
                _ = try await ctx.resident.appendToSession(token: begun.token, samples: samples)
                let text = try await ctx.resident.finishSession(token: begun.token).text
                await ctx.resident.endSession(token: begun.token, claim: begun.claim)
                return text
            } catch {
                await ctx.resident.endSession(token: begun.token, claim: begun.claim)
                throw error
            }
        }
    }

    private func sessionObject() -> [String: Any] {
        [
            "type": "transcription",
            "id": sessionId,
            "object": "realtime.transcription_session",
            "audio": [
                "input": [
                    "format": ["type": format.rawValue, "rate": rate],
                    "transcription": ["model": model.map { $0 as Any } ?? NSNull()],
                    "turn_detection": NSNull(),
                ]
            ],
        ]
    }

    // INVENTED: the `code` strings this server sends; OpenAI's pages do not list them.
    func error(_ code: String, _ message: String, _ eventId: String? = nil) async {
        await send([
            "type": "error",
            "error": [
                "type": "invalid_request_error", "code": code, "message": message,
                "event_id": eventId.map { $0 as Any } ?? NSNull(),
            ] as [String: Any],
        ])
    }

    private func send(_ event: [String: Any]) async {
        var event = event
        event["event_id"] = "event_\(Self.shortId())"
        guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else {
            return
        }
        try? await outbound.write(.text(String(decoding: data, as: UTF8.self)))
    }
}
