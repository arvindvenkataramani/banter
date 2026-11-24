import FluidServerKit
import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore

/// OpenAI Realtime at `/v1/realtime`, as a speaking subset: a response speaks its
/// `input_text` parts as written (`verbatim-speech`), in 24 kHz PCM.
func registerRealtimeSpeech(on wsRouter: Router<BasicWebSocketRequestContext>, ctx: TtsAppContext) {
    wsRouter.ws("/v1/realtime") { inbound, outbound, wsCtx in
        let params = queryDictionary(wsCtx.request.uri.queryParameters)
        let session = RealtimeSpeech(ctx: ctx, sink: WebSocketSink(outbound), model: params["model"])
        await session.created()
        do {
            for try await frame in inbound.messages(maxSize: 1024 * 1024) {
                guard case .text(let string) = frame else {
                    await session.error("invalid_event", "client events are JSON text messages")
                    continue
                }
                await session.handle(string)
            }
        } catch {
            await session.shutdown()
            throw error
        }
        await session.shutdown()
    }
}

private actor RealtimeSpeech {
    private let ctx: TtsAppContext
    private let sink: WebSocketSink
    private let sessionId = "sess_\(RealtimeSpeech.shortId())"
    /// The roster model to speak with; nil uses the resident one, else the roster's first.
    private var model: String?
    private var voice: String?
    private var running: (id: String, task: Task<Void, Never>)?

    init(ctx: TtsAppContext, sink: WebSocketSink, model: String?) {
        self.ctx = ctx
        self.sink = sink
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
        case "response.create":
            await create(event["response"] as? [String: Any] ?? [:], eventId: eventId)
        case "response.cancel":
            await cancel(eventId: eventId)
        default:
            await error("unsupported_event", "\(type) is not served; this server speaks response text", eventId)
        }
    }

    private func update(_ session: [String: Any], eventId: String?) async {
        if let type = session["type"] as? String, type != "realtime" {
            return await error("unsupported_session", "only a realtime session is served", eventId)
        }
        let output = (session["audio"] as? [String: Any])?["output"] as? [String: Any] ?? [:]
        if let format = output["format"] as? [String: Any], let name = format["type"] as? String,
            name != "audio/pcm"
        {
            return await error("unsupported_format", "audio.output.format must be audio/pcm", eventId)
        }
        if let named = session["model"] as? String {
            guard ctx.roster.model(id: named) != nil else {
                return await error("unknown_model", TtsError.unknownModel(named).description, eventId)
            }
            model = named
        }
        if let named = output["voice"] as? String { voice = named }
        await send(["type": "session.updated", "session": sessionObject()])
    }

    /// The text of every `input_text` part in the response's `input`, in order.
    private static func verbatim(_ response: [String: Any]) -> String {
        let items = response["input"] as? [[String: Any]] ?? []
        let parts = items.flatMap { $0["content"] as? [[String: Any]] ?? [] }
        return parts.filter { $0["type"] as? String == "input_text" }
            .compactMap { $0["text"] as? String }
            .joined(separator: " ")
    }

    private func create(_ response: [String: Any], eventId: String?) async {
        guard running == nil else {
            return await error(
                "conversation_already_has_active_response", "a response is already being spoken", eventId)
        }
        let text = Self.verbatim(response)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return await error("missing_text", "response.input carries no input_text to speak", eventId)
        }
        let id = "resp_\(Self.shortId())"
        let item = "item_\(Self.shortId())"
        await send(["type": "response.created", "response": responseObject(id, status: "in_progress")])
        let task = Task { await self.speak(text, response: id, item: item) }
        running = (id, task)
    }

    private func cancel(eventId: String?) async {
        guard let active = running else {
            return await error("response_cancel_not_active", "no response is being spoken", eventId)
        }
        active.task.cancel()
        await active.task.value
        // Sent here: a write from the cancelled task would itself be cancelled.
        await send(["type": "response.done", "response": responseObject(active.id, status: "cancelled")])
        running = nil
    }

    private func speak(_ text: String, response id: String, item: String) async {
        var status = "completed"
        do {
            let request = try await synthesisRequest(text)
            try await stream(request, response: id, item: item)
            if Task.isCancelled {
                status = "cancelled"
            } else {
                await send([
                    "type": "response.output_audio.done", "response_id": id, "item_id": item,
                    "output_index": 0, "content_index": 0,
                ])
            }
        } catch {
            status = Task.isCancelled ? "cancelled" : "failed"
            if !Task.isCancelled {
                let message = (error as? any FluidServerError)?.description ?? "\(error)"
                await self.error("synthesis_failed", message)
            }
        }
        guard !Task.isCancelled else { return }
        await send(["type": "response.done", "response": responseObject(id, status: status)])
        running = nil
    }

    private func synthesisRequest(_ text: String) async throws -> SynthesisRequest {
        let resident = await ctx.resident.currentModel.flatMap { ctx.roster.id(forKey: $0) }
        guard let modelId = model ?? resident ?? ctx.roster.models.first?.id,
            let key = ctx.roster.key(for: modelId)
        else { throw TtsError.notLoaded }
        let who = try await ctx.voiceTerms(voice: voice, refAudio: nil, refText: nil, model: modelId)
        try await ctx.resident.ensureLoaded(key)
        return SynthesisRequest(
            text: text, voice: who.voice, refAudio: who.refAudio, refText: who.refText, language: nil,
            speed: nil, temperature: nil, seed: nil, cfgWeight: nil, repetitionPenalty: nil, minP: nil,
            topP: nil, topK: nil, emotion: nil, deEss: nil, maxTokensPerChunk: nil, alpha: nil, beta: nil,
            noiseScale: nil, totalSteps: nil, silenceDuration: nil)
    }

    /// Sends the audio as `response.output_audio.delta` events until it ends or the task is cancelled.
    private func stream(_ request: SynthesisRequest, response id: String, item: String) async throws {
        func delta(_ audio: Data) async {
            guard !audio.isEmpty else { return }
            await send([
                "type": "response.output_audio.delta", "response_id": id, "item_id": item,
                "output_index": 0, "content_index": 0, "delta": audio.base64EncodedString(),
            ])
        }
        let begun: (token: UInt64, stream: AsyncThrowingStream<[Float], Error>, sampleRate: Int)
        do {
            begun = try await ctx.resident.beginStream(request)
        } catch TtsError.unsupported {
            let result = try await ctx.resident.synthesize(request)
            let encoder = try PcmStreamEncoder(sampleRate: result.sampleRate)
            var audio = try encoder.encode(result.samples)
            audio.append(try encoder.finish())
            if !Task.isCancelled { await delta(audio) }
            return
        }
        do {
            let encoder = try PcmStreamEncoder(sampleRate: begun.sampleRate)
            for try await chunk in bufferedChunks(
                begun.stream, interval: defaultStreamingInterval, sampleRate: begun.sampleRate)
            {
                if Task.isCancelled { break }
                await delta(try encoder.encode(chunk))
            }
            if !Task.isCancelled { await delta(try encoder.finish()) }
        } catch {
            await ctx.resident.endStream(token: begun.token)
            throw error
        }
        await ctx.resident.endStream(token: begun.token)
    }

    func shutdown() async {
        if let active = running {
            active.task.cancel()
            await active.task.value
        }
    }

    private func sessionObject() -> [String: Any] {
        [
            "type": "realtime", "id": sessionId, "object": "realtime.session",
            "model": model.map { $0 as Any } ?? NSNull(),
            "output_modalities": ["audio"],
            "audio": [
                "output": [
                    "format": ["type": "audio/pcm", "rate": AudioFormat.pcmSampleRate],
                    "voice": voice.map { $0 as Any } ?? NSNull(),
                ]
            ],
        ]
    }

    private func responseObject(_ id: String, status: String) -> [String: Any] {
        ["id": id, "object": "realtime.response", "status": status]
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
        try? await sink.sendText(jsonText(event))
    }
}
