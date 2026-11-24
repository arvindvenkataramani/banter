import FluidServerKit
import Foundation

/// What this server's registry entry declares it provides, checked against what the build serves.
struct Provisions: Sendable {
    let declared: [Provision]

    static let none = Provisions(declared: [])

    /// Each API this build serves, with the parts of it the build lacks.
    static let build: [String: [String]] = [
        "fluid.stt.stream": [],
        "openai.audio.transcriptions": [
            "parameter:language", "parameter:languages", "parameter:keywords", "parameter:prompt",
            "parameter:temperature", "parameter:include", "value:include=logprobs",
            "parameter:chunking_strategy", "parameter:known_speaker_names",
            "parameter:known_speaker_references", "value:response_format=srt",
            "value:response_format=vtt", "value:response_format=diarized_json",
            "value:timestamp_granularities=segment",
        ],
        "triton.model-repository": ["field:index.version"],
        "deepgram.listen.prerecorded": [
            "parameter:callback", "parameter:callback_method", "parameter:extra", "parameter:sentiment",
            "parameter:summarize", "parameter:tag", "parameter:topics", "parameter:custom_topic",
            "parameter:custom_topic_mode", "parameter:intents", "parameter:custom_intent",
            "parameter:custom_intent_mode", "parameter:detect_entities", "parameter:detect_language",
            "parameter:diarize", "parameter:diarize_model", "parameter:dictation", "parameter:filler_words",
            "parameter:keyterm", "parameter:keywords", "parameter:language", "parameter:language_hint",
            "parameter:measurements", "parameter:multichannel", "parameter:numerals", "parameter:paragraphs",
            "parameter:profanity_filter", "parameter:punctuate", "parameter:redact", "parameter:redact_usage",
            "parameter:replace", "parameter:search", "parameter:smart_format", "parameter:utterances",
            "parameter:utt_split", "parameter:version", "parameter:mip_opt_out",
            "value:encoding=mulaw", "value:encoding=amr-nb", "value:encoding=amr-wb", "value:encoding=opus",
            "value:encoding=speex", "value:encoding=g729",
        ],
        "deepgram.listen.live": [
            "parameter:callback", "parameter:callback_method", "parameter:detect_entities", "parameter:diarize",
            "parameter:diarize_model", "parameter:dictation", "parameter:extra", "parameter:keyterm",
            "parameter:keywords", "parameter:language", "parameter:language_hint", "parameter:mip_opt_out",
            "parameter:multichannel", "parameter:numerals", "parameter:profanity_filter", "parameter:punctuate",
            "parameter:redact", "parameter:redact_usage", "parameter:replace", "parameter:search",
            "parameter:smart_format", "parameter:tag", "parameter:utterance_end_ms", "parameter:vad_events",
            "parameter:version", "value:encoding=linear32", "value:encoding=flac", "value:encoding=alaw",
            "value:encoding=mulaw", "value:encoding=amr-nb", "value:encoding=amr-wb",
            "value:encoding=ogg-opus", "value:encoding=speex", "value:encoding=g729",
            "client-message:Configure", "server-message:ConfigureSuccess", "server-message:ConfigureFailure",
            "server-message:UtteranceEnd", "server-message:SpeechStarted",
        ],
        "openai.realtime": [
            "mode:conversation", "client-message:conversation.item.create",
            "client-message:conversation.item.delete", "client-message:conversation.item.retrieve",
            "client-message:conversation.item.truncate", "client-message:output_audio_buffer.clear",
            "client-message:response.cancel", "client-message:response.create",
            "parameter:audio.input.noise_reduction", "parameter:audio.output.format",
            "parameter:audio.output.voice", "parameter:include", "value:audio.input.format=audio/pcmu",
            "value:audio.input.format=audio/pcma", "value:audio.input.turn_detection=server_vad",
            "value:audio.input.turn_detection=semantic_vad",
        ],
    ]

    /// Reads the `provides` of service `provider` and refuses an entry claiming more than the build serves.
    static func load(registry: URL, provider: String) throws -> Provisions {
        let declared = try ProvisionCheck.read(registry: registry, service: provider)
        try ProvisionCheck.check(declared, service: provider, build: build)
        return Provisions(declared: declared)
    }

    /// The listen route's endpointing default, as its provision declares it.
    var listenEndpointingMs: Int? {
        declared.declaredDefault("endpointing", of: "deepgram.listen.live")?.int
    }
}
