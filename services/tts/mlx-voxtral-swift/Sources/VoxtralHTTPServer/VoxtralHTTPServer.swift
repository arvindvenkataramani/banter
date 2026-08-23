import ArgumentParser
import Foundation
import Hummingbird
import MLX
import VoxtralCore

@main
struct VoxtralHTTPServer: AsyncParsableCommand {
    @Option(name: .long, help: "Model ID (e.g. tts-4b-4bit, tts-4b-6bit, tts-4b-mlx)")
    var model: String = "tts-4b-4bit"

    @Option(name: .long, help: "Port to listen on")
    var port: Int = 8003

    @Option(name: .long, help: "Host to bind to")
    var host: String = "0.0.0.0"

    func run() async throws {
        guard let modelInfo = VoxtralTTSRegistry.model(withId: model) else {
            print("Unknown model: \(model)")
            print("Available models:")
            VoxtralTTSRegistry.printAvailableModels()
            throw ExitCode.failure
        }

        print("Loading \(modelInfo.name)...")
        let pipeline = VoxtralTTSPipeline()
        try await pipeline.loadModel(modelInfo: modelInfo) { progress, status in
            print("  [\(Int(progress * 100))%] \(status)")
        }
        print("Model loaded.")

        let state = ServerState(pipeline: pipeline)

        let router = Router()

        router.get("/health") { _, _ in
            return Response(
                status: .ok,
                headers: [.contentType: "application/json"],
                body: .init(byteBuffer: .init(string: #"{"status":"ok"}"#))
            )
        }

        router.post("/v1/audio/speech") { request, context in
            let body = try await request.body.collect(upTo: 1_048_576)
            let json = try JSONDecoder().decode(SpeechRequest.self, from: body)

            let voice = VoxtralVoice(rawValue: json.voice) ?? .neutralFemale
            let result = try await state.pipeline.synthesize(text: json.input, voice: voice)

            let wavData = wavBytes(waveform: result.waveform, sampleRate: result.sampleRate)

            return Response(
                status: .ok,
                headers: [.contentType: "audio/wav"],
                body: .init(byteBuffer: .init(data: wavData))
            )
        }

        let app = Application(router: router, configuration: .init(address: .hostname(host, port: port)))
        print("Listening on \(host):\(port)")
        try await app.run()
    }
}

struct ServerState: Sendable {
    let pipeline: VoxtralTTSPipeline
}

struct SpeechRequest: Decodable {
    let input: String
    let voice: String
}

/// Build WAV file bytes in memory (16-bit PCM, mono).
/// Mirrors WAVWriter.write() from VoxtralCore but returns Data instead of writing to disk.
func wavBytes(waveform: MLXArray, sampleRate: Int, bitDepth: Int = 16) -> Data {
    let samples = waveform.asType(.float32)
    let numSamples = samples.dim(0)
    let numChannels = 1

    let maxVal = Float(Int16.max)
    let clipped = MLX.clip(samples, min: MLXArray(Float(-1.0)), max: MLXArray(Float(1.0)))
    let scaled = (clipped * MLXArray(maxVal)).asType(.int16)
    // Force GPU->CPU transfer
    MLX.eval(scaled)

    var data = Data()
    let dataSize = numSamples * numChannels * (bitDepth / 8)
    let fileSize = 36 + dataSize

    // RIFF header
    data.append(contentsOf: "RIFF".utf8)
    data.append(contentsOf: withUnsafeBytes(of: UInt32(fileSize).littleEndian) { Array($0) })
    data.append(contentsOf: "WAVE".utf8)

    // fmt chunk
    data.append(contentsOf: "fmt ".utf8)
    data.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: UInt16(numChannels).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Array($0) })
    let byteRate = sampleRate * numChannels * (bitDepth / 8)
    data.append(contentsOf: withUnsafeBytes(of: UInt32(byteRate).littleEndian) { Array($0) })
    let blockAlign = numChannels * (bitDepth / 8)
    data.append(contentsOf: withUnsafeBytes(of: UInt16(blockAlign).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: UInt16(bitDepth).littleEndian) { Array($0) })

    // data chunk
    data.append(contentsOf: "data".utf8)
    data.append(contentsOf: withUnsafeBytes(of: UInt32(dataSize).littleEndian) { Array($0) })
    scaled.asArray(Int16.self).withUnsafeBufferPointer { buffer in
        data.append(buffer)
    }

    return data
}
