import Hummingbird
import Logging
import NIOCore
import NIOEmbedded
import XCTest

@testable import FluidServerKit

/// The HTTP surface is shared because it is externally visible. These hold the
/// shapes a client sees, rather than the code that produces them.
final class HttpSurfaceTests: XCTestCase {
    /// A thrown error and a returned one must produce the same status.
    ///
    /// Hummingbird consults `HTTPResponseError` and nothing else when a route
    /// throws, so an error that carried a status without conforming rendered as
    /// a bodyless 500 from every route that rethrows and correctly only from
    /// the ones building a response by hand. `DELETE /v1/models` during live
    /// work is exactly that case, and it answered 500 until this held.
    func testABusySlotIsAConflictWhetherThrownOrReturned() throws {
        let error = SlotError.busy(.stream)
        XCTAssertEqual(error.status, .conflict)

        let returned = error.errorResponse()
        XCTAssertEqual(returned.status, .conflict)
        XCTAssertEqual(returned.headers[.contentType], "application/json")

        // The same error reached through Hummingbird's own protocol.
        let thrown: any HTTPResponseError = error
        XCTAssertEqual(thrown.status, .conflict)
    }

    func testAnEmptySlotIsAConflictToo() {
        XCTAssertEqual(SlotError.empty.status, .conflict)
    }

    func testTheErrorBodyNamesWhatHoldsTheSlot() {
        // A caller that is refused learns what it is waiting behind, which is
        // the difference between a useful log line and "busy".
        XCTAssertTrue(SlotError.busy(.stream).description.contains("stream"))
        XCTAssertTrue(SlotError.busy(.batch).description.contains("batch"))
        XCTAssertTrue(SlotError.busy(.session).description.contains("session"))
    }

    // MARK: - CORS

    func testAnAllowlistIsOnlyBuiltWhenOriginsAreConfigured() {
        // A server with nothing set adds no middleware, rather than one that
        // refuses everything.
        XCTAssertNil(
            CorsAllowlist<BasicRequestContext>(fromEnvironment: "FLUID_CORS_ORIGINS_UNSET_IN_TESTS")
        )
    }

    func testTheAllowlistParsesACommaSeparatedList() {
        let cors = CorsAllowlist<BasicRequestContext>(
            origins: ["https://a.example", "https://b.example"])
        XCTAssertEqual(cors.origins.count, 2)
        XCTAssertTrue(cors.origins.contains("https://a.example"))
    }

    /// A refused request is still a cross-origin request.
    ///
    /// The allowlist adds its headers to what `next` returns, so an error a
    /// route *throws* travelled past it and Hummingbird rendered the response
    /// above the chain — bare, with no `Access-Control-Allow-Origin`. The
    /// browser then reports the origin as disallowed and hides the real
    /// status, so "no model is loaded" reaches the dashboard as a CORS
    /// failure and the allowlist gets blamed for a 409.
    func testAThrownErrorStillCarriesTheCorsHeaders() async throws {
        let cors = CorsAllowlist<BasicRequestContext>(origins: ["https://a.example"])
        let request = Request(
            head: .init(method: .post, scheme: nil, authority: nil, path: "/x",
                        headerFields: [.origin: "https://a.example"]),
            body: .init(buffer: ByteBuffer()))
        let context = BasicRequestContext(source: .init(
            channel: EmbeddedChannel(), logger: Logger(label: "test")))

        let response = try await cors.handle(request, context: context) { _, _ in
            throw SlotError.empty
        }

        XCTAssertEqual(response.status, .conflict)
        XCTAssertEqual(response.headers[.accessControlAllowOrigin], "https://a.example")
        XCTAssertEqual(response.headers[.vary], "Origin")
    }

    /// An origin that is not on the list gets no headers even when the route
    /// throws — catching the error must not turn the allowlist into an echo.
    func testAThrownErrorToAForeignOriginGetsNoHeaders() async throws {
        let cors = CorsAllowlist<BasicRequestContext>(origins: ["https://a.example"])
        let request = Request(
            head: .init(method: .post, scheme: nil, authority: nil, path: "/x",
                        headerFields: [.origin: "https://evil.example"]),
            body: .init(buffer: ByteBuffer()))
        let context = BasicRequestContext(source: .init(
            channel: EmbeddedChannel(), logger: Logger(label: "test")))

        do {
            _ = try await cors.handle(request, context: context) { _, _ in
                throw SlotError.empty
            }
            XCTFail("expected the error to propagate untouched")
        } catch let error as SlotError {
            XCTAssertEqual(error.status, .conflict)
        }
    }

    // MARK: - Argument parsing

    func testArgumentsOverrideTheDefaultPort() throws {
        let args = try ServerArgs.parse(
            defaultPort: 8769, arguments: ["fluid-tts", "--port", "9000"])
        XCTAssertEqual(args.port, 9000)
    }

    func testTheDefaultPortStandsWhenNoneIsGiven() throws {
        let args = try ServerArgs.parse(defaultPort: 8769, arguments: ["fluid-tts"])
        XCTAssertEqual(args.port, 8769)
    }

    func testAServerBindsLoopbackUnlessToldOtherwise() throws {
        let args = try ServerArgs.parse(defaultPort: 8769, arguments: ["fluid-tts"])
        XCTAssertEqual(args.bind, .local)
        XCTAssertEqual(args.host, "127.0.0.1")
    }

    func testBindAllListensOnEveryInterface() throws {
        let args = try ServerArgs.parse(
            defaultPort: 8769, arguments: ["fluid-tts", "--bind", "all"])
        XCTAssertEqual(args.host, "0.0.0.0")
    }

    func testAnUnknownBindIsRefused() {
        XCTAssertThrowsError(
            try ServerArgs.parse(defaultPort: 8769, arguments: ["fluid-tts", "--bind", "lan"]))
        XCTAssertThrowsError(
            try ServerArgs.parse(defaultPort: 8769, arguments: ["fluid-tts", "--bind"]))
    }

    func testTheModelsDirectoryIsRead() throws {
        let args = try ServerArgs.parse(
            defaultPort: 8769, arguments: ["fluid-tts", "--models-dir", "/tmp/models"])
        XCTAssertEqual(args.modelsDirectory?.path, "/tmp/models")
    }
}
