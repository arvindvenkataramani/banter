import FluidAudio
import Foundation

actor TranscriptionQueue {
    private let asrManager: AsrManager
    private let decoderLayerCount: Int

    init(asrManager: AsrManager, decoderLayerCount: Int) {
        self.asrManager = asrManager
        self.decoderLayerCount = decoderLayerCount
    }

    func transcribe(url: URL) async throws -> ASRResult {
        var state = TdtDecoderState.make(decoderLayers: decoderLayerCount)
        return try await asrManager.transcribe(url, decoderState: &state)
    }
}
