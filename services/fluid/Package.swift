// swift-tools-version: 6.0
import PackageDescription

/// Both Fluid servers, and the kit they share.
///
/// One package so shared code is an ordinary target dependency: no path
/// dependencies between packages, and no version skew between two copies of the
/// same lifecycle code.
///
/// Two executables, not one, and this is required rather than preference.
/// FluidAudio issue #661 records `EXC_BAD_ACCESS` in libBNNS when two distinct
/// CoreML managers predict concurrently — they land on Apple's shared
/// `com.apple.e5rt.concurrentExecutionQueue` and corrupt E5RT scratch state. An
/// STT manager and a TTS manager in one process are two managers, and the voice
/// loop needs exactly that concurrency, because STT running live while TTS
/// synthesises is what barge-in is. One process would need a serialiser across
/// both modalities, which makes barge-in impossible by construction.
let package = Package(
    name: "fluid-server",
    platforms: [
        // Chatterbox and NeuTTS-2E keep their decoder KV cache in CoreML
        // `MLState` buffers, which is macOS 15+. The STT server targeted 14
        // before the collapse; the TTS backends set the floor for both.
        .macOS(.v15)
    ],
    products: [
        .executable(name: "fluid-stt", targets: ["FluidServerSTT"]),
        .executable(name: "fluid-tts", targets: ["FluidServerTTS"]),
        .library(name: "FluidServerKit", targets: ["FluidServerKit"]),
    ],
    dependencies: [
        // Pinned to a fork, not upstream: unpatched FluidAudio garbles any text
        // containing ( ) / … or an emoji and cuts sentences mid-phrase. This
        // branch carries the three fixes in patches/. Read `patches/README.md`
        // before changing this pin: a bump that drops them fails silently, in
        // the audio.
        //
        // A revision, not a tag, because Chatterbox landed on upstream main
        // after v0.15.7 and is in no release.
        .package(
            url: "https://github.com/arvindvenkataramani/FluidAudio.git",
            revision: "6843a35b46da4f79a653bafe2cb09624eb07dca1"
        ),
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.0.0"),
        .package(
            url: "https://github.com/hummingbird-project/hummingbird-websocket.git",
            from: "2.0.0"),
        .package(url: "https://github.com/vapor/multipart-kit.git", from: "4.0.0"),
        // The STT server's health and model-lifecycle surface is generated from
        // Sources/FluidServerSTT/openapi.yaml, which is the source of truth: its
        // handlers must satisfy the generated protocol, so the spec cannot drift
        // from the implementation without failing to compile. The TTS server
        // hand-writes its routes; the kit shares the response shapes, not how
        // either registers handlers.
        .package(url: "https://github.com/apple/swift-openapi-generator.git", from: "1.0.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime.git", from: "1.0.0"),
        .package(
            url: "https://github.com/hummingbird-project/swift-openapi-hummingbird.git",
            from: "2.0.0"),
    ],
    targets: [
        // What both servers share: the resident-model lifecycle, idle release,
        // the externally visible HTTP surface, and the small utilities. Not the
        // backend drivers, and not the two audio modules — STT decodes Opus off
        // the wire, TTS encodes what it generates, and there is no common
        // contract underneath them.
        .target(
            name: "FluidServerKit",
            dependencies: [
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdWebSocket", package: "hummingbird-websocket"),
            ],
            path: "Sources/FluidServerKit"
        ),
        // libopus, from Homebrew. The browser sends raw Opus packets (WebCodecs
        // AudioEncoder, not MediaRecorder), so this decodes packets directly —
        // there is no container to parse.
        .systemLibrary(
            name: "COpus", path: "Sources/COpus", pkgConfig: "opus",
            providers: [.brew(["opus"])]
        ),
        .executableTarget(
            name: "FluidServerSTT",
            dependencies: [
                "FluidServerKit",
                "COpus",
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdWebSocket", package: "hummingbird-websocket"),
                .product(name: "MultipartKit", package: "multipart-kit"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIHummingbird", package: "swift-openapi-hummingbird"),
            ],
            path: "Sources/FluidServerSTT",
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
            ]
        ),
        .executableTarget(
            name: "FluidServerTTS",
            dependencies: [
                "FluidServerKit",
                .product(name: "FluidAudio", package: "FluidAudio"),
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdWebSocket", package: "hummingbird-websocket"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIHummingbird", package: "swift-openapi-hummingbird"),
            ],
            path: "Sources/FluidServerTTS",
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")
            ]
        ),
        .testTarget(
            name: "FluidServerSTTTests",
            dependencies: ["FluidServerSTT", "FluidServerKit"],
            path: "Tests/FluidServerSTTTests"
        ),
        .testTarget(
            name: "FluidServerKitTests",
            dependencies: ["FluidServerKit"],
            path: "Tests/FluidServerKitTests"
        ),
        .testTarget(
            name: "FluidServerTTSTests",
            dependencies: ["FluidServerTTS", "FluidServerKit"],
            path: "Tests/FluidServerTTSTests"
        ),
    ]
)
