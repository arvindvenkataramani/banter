import Foundation
import Hummingbird
import HummingbirdWebSocket
import NIOCore
import XCTest

/// A server's real routers on an ephemeral loopback port, for the tests that
/// check what a client sees on the wire: statuses, headers, the order of
/// messages, and the close code a socket ends with. Nothing here loads model
/// weights; the tests hand the routers a context built on stand-in models.
///
/// The same file sits in each server's test target, since two test targets
/// cannot share one.
final class LiveServer: @unchecked Sendable {
    private actor PortBox {
        private(set) var value: Int?
        func set(_ port: Int?) { value = port }
    }

    let port: Int
    private let task: Task<Void, Error>

    private init(port: Int, task: Task<Void, Error>) {
        self.port = port
        self.task = task
    }

    static func start(
        router: Router<BasicRequestContext>,
        webSockets: Router<BasicWebSocketRequestContext>
    ) async throws -> LiveServer {
        let box = PortBox()
        let app = Application(
            router: router,
            server: .http1WebSocketUpgrade(webSocketRouter: webSockets),
            configuration: .init(address: .hostname("127.0.0.1", port: 0), serverName: "test"),
            onServerRunning: { channel in await box.set(channel.localAddress?.port) })
        let task = Task { try await app.runService() }
        for _ in 0..<500 {
            if let port = await box.value { return LiveServer(port: port, task: task) }
            try await Task.sleep(for: .milliseconds(10))
        }
        task.cancel()
        throw LiveServerError.neverListened
    }

    func stop() async {
        task.cancel()
        _ = try? await task.value
    }

    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }
    func wsURL(_ pathAndQuery: String) -> URL { URL(string: "ws://127.0.0.1:\(port)\(pathAndQuery)")! }

    /// One request, answered whole.
    func request(
        _ method: String, _ path: String, headers: [String: String] = [:], body: Data? = nil
    ) async throws -> HttpReply {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        request.httpBody = body
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = response as! HTTPURLResponse
        return HttpReply(status: http.statusCode, response: http, body: data)
    }

    func postJSON(_ path: String, _ object: Any) async throws -> HttpReply {
        try await request(
            "POST", path, headers: ["Content-Type": "application/json"],
            body: try JSONSerialization.data(withJSONObject: object))
    }

    /// A request whose body is read as it arrives. Returns the status, headers
    /// and a byte stream, so a test can look at what has been sent before the
    /// server has finished.
    func stream(
        _ method: String, _ path: String, headers: [String: String] = [:], body: Data? = nil
    ) async throws -> (response: HTTPURLResponse, bytes: URLSession.AsyncBytes) {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        request.httpBody = body
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        return (response as! HTTPURLResponse, bytes)
    }
}

enum LiveServerError: Error { case neverListened }

struct HttpReply {
    let status: Int
    let response: HTTPURLResponse
    let body: Data

    var contentType: String { response.value(forHTTPHeaderField: "Content-Type") ?? "" }
    var text: String { String(decoding: body, as: UTF8.self) }
    var json: Any? { try? JSONSerialization.jsonObject(with: body) }
    var object: [String: Any]? { json as? [String: Any] }
}

/// `multipart/form-data` with one file part and any number of plain fields.
func multipartBody(
    boundary: String, file: Data, filename: String = "audio.wav", fields: [String: String] = [:]
) -> Data {
    var body = Data()
    func add(_ text: String) { body.append(Data(text.utf8)) }
    for (name, value) in fields.sorted(by: { $0.key < $1.key }) {
        add("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
    }
    add(
        "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n"
            + "Content-Type: application/octet-stream\r\n\r\n")
    body.append(file)
    add("\r\n--\(boundary)--\r\n")
    return body
}

/// A WebSocket client that reports what the server sent and the exact close
/// code it ended with, which `URLSessionWebSocketTask` passes through
/// unchanged for the 4001 to 4010 range.
final class WSClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    enum Event: Equatable {
        case text(String)
        case binary(Data)
        /// The connection ended with this close code.
        case closed(Int)

        var text: String? { if case .text(let text) = self { return text } else { return nil } }
        var object: [String: Any]? {
            guard let text, let data = text.data(using: .utf8) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }
        var type: String? { object?["type"] as? String }
    }

    private let lock = NSLock()
    private var queue: [Event] = []
    private var closeCode: Int?
    private var receiveEndedAt: ContinuousClock.Instant?
    private var task: URLSessionWebSocketTask!
    private var session: URLSession!

    init(url: URL) {
        super.init()
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: url)
        task.resume()
        pump()
    }

    private func pump() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                let event: Event
                switch message {
                case .string(let text): event = .text(text)
                case .data(let data): event = .binary(data)
                @unknown default: return
                }
                self.lock.withLock { self.queue.append(event) }
                self.pump()
            case .failure:
                self.lock.withLock { self.receiveEndedAt = .now }
            }
        }
    }

    func urlSession(
        _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
        lock.withLock { self.closeCode = closeCode.rawValue }
    }

    func send(_ text: String) async throws { try await task.send(.string(text)) }
    func send(_ data: Data) async throws { try await task.send(.data(data)) }
    func send(json object: Any) async throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try await send(String(decoding: data, as: UTF8.self))
    }

    /// The next message the server sent, or `.closed` once the connection has
    /// ended, or nil when nothing arrives within `timeout`.
    func next(timeout: Duration = .seconds(5)) async -> Event? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            let ready: Event? = lock.withLock {
                if !queue.isEmpty { return queue.removeFirst() }
                guard let endedAt = receiveEndedAt else { return nil }
                if let code = closeCode { return .closed(code) }
                // A failure that no close code explains, such as a refused connection.
                if ContinuousClock.now - endedAt > .seconds(1) { return .closed(-1) }
                return nil
            }
            if let ready { return ready }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return nil
    }

    /// The next text message that is not binary audio, or nil.
    func nextText(timeout: Duration = .seconds(5)) async -> Event? {
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            guard let event = await next(timeout: deadline - ContinuousClock.now) else { return nil }
            if case .binary = event { continue }
            return event
        }
        return nil
    }

    /// Messages until one satisfies `done`, the connection closes, or the
    /// timeout passes. Includes the one that satisfied it.
    func collect(
        timeout: Duration = .seconds(5), until done: (Event) -> Bool
    ) async -> [Event] {
        var events: [Event] = []
        let deadline = ContinuousClock.now + timeout
        while ContinuousClock.now < deadline {
            guard let event = await next(timeout: deadline - ContinuousClock.now) else { break }
            events.append(event)
            if done(event) { break }
            if case .closed = event { break }
        }
        return events
    }

    /// Everything the server sends until it has been silent for `quiet`.
    func drain(quiet: Duration) async -> [Event] {
        var events: [Event] = []
        while let event = await next(timeout: quiet) {
            events.append(event)
            if case .closed = event { break }
        }
        return events
    }

    func close() {
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}
