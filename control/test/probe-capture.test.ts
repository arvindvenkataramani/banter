import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureSink } from "../probe/capture";

let dir: string;
let sink: CaptureSink;

const OWN_SESSION = "agent:example:probe-test";
const FOREIGN_SESSION = "agent:main:main";

function makeSink(opts: { allowAll?: boolean } = {}) {
  return new CaptureSink({
    path: join(dir, "capture.jsonl"),
    allowedSessionKeys: [OWN_SESSION],
    allowAll: opts.allowAll ?? false,
  });
}

function entries(): Record<string, unknown>[] {
  sink.close();
  return readFileSync(join(dir, "capture.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-capture-"));
  sink = makeSink();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("capture sink", () => {
  it("records a frame for an allowed session in full with monotonic and wall timestamps", () => {
    const frame = {
      type: "event",
      event: "chat",
      payload: { sessionKey: OWN_SESSION, runId: "r1", seq: 3, state: "delta", message: "hi" },
    };
    sink.recordFrame("in", JSON.stringify(frame));
    const [entry] = entries();
    expect(entry.kind).toBe("frame");
    expect(entry.dir).toBe("in");
    expect(typeof entry.tMono).toBe("number");
    expect(typeof entry.tWall).toBe("number");
    expect(entry.frame).toEqual(frame);
  });

  it("records a frame for a foreign session as envelope only, with no content fields", () => {
    const frame = {
      type: "event",
      event: "agent",
      payload: {
        sessionKey: FOREIGN_SESSION,
        runId: "r9",
        seq: 7,
        stream: "tool",
        ts: 123,
        data: { phase: "start", name: "exec", args: { command: "secret stuff" } },
      },
    };
    sink.recordFrame("in", JSON.stringify(frame));
    const [entry] = entries();
    expect(entry.kind).toBe("envelope");
    expect(entry.event).toBe("agent");
    expect(entry.sessionKey).toBe(FOREIGN_SESSION);
    expect(entry.runId).toBe("r9");
    expect(entry.stream).toBe("tool");
    expect(entry.phase).toBe("start");
    expect(entry.seq).toBe(7);
    const flat = JSON.stringify(entry);
    expect(flat).not.toContain("secret stuff");
    expect(flat).not.toContain("exec");
  });

  it("records foreign session frames in full when allowAll is set", () => {
    sink.close();
    sink = makeSink({ allowAll: true });
    const frame = {
      type: "event",
      event: "chat",
      payload: { sessionKey: FOREIGN_SESSION, seq: 1, state: "delta", message: "other convo" },
    };
    sink.recordFrame("in", JSON.stringify(frame));
    const [entry] = entries();
    expect(entry.kind).toBe("frame");
    expect(JSON.stringify(entry)).toContain("other convo");
  });

  it("strips the compaction checkpoint summary and records its byte length", () => {
    const summary = "x".repeat(5000);
    const frame = {
      type: "event",
      event: "session.message",
      payload: {
        sessionKey: OWN_SESSION,
        messageSeq: 4,
        message: { role: "assistant", content: "ok" },
        session: { latestCompactionCheckpoint: { summary } },
      },
    };
    sink.recordFrame("in", JSON.stringify(frame));
    const [entry] = entries();
    const captured = entry.frame as {
      payload: { session: { latestCompactionCheckpoint: { summary: unknown } } };
    };
    expect(captured.payload.session.latestCompactionCheckpoint.summary).toEqual({
      omitted: true,
      bytes: 5000,
    });
  });

  it("redacts the auth token in outbound connect frames", () => {
    const frame = {
      type: "req",
      id: "1",
      method: "connect",
      params: { auth: { token: "super-secret-token" }, caps: ["tool-events"] },
    };
    sink.recordFrame("out", JSON.stringify(frame));
    const [entry] = entries();
    expect(JSON.stringify(entry)).not.toContain("super-secret-token");
    const captured = entry.frame as { params: { auth: unknown; caps: string[] } };
    expect(captured.params.auth).toEqual({ redacted: true });
    expect(captured.params.caps).toEqual(["tool-events"]);
  });

  it("redacts device tokens in the hello-ok frame", () => {
    const frame = {
      type: "hello-ok",
      protocol: 4,
      auth: { deviceToken: "live-device-token", role: "operator", deviceTokens: ["a", "b"] },
    };
    sink.recordFrame("in", JSON.stringify(frame));
    const [entry] = entries();
    const flat = JSON.stringify(entry);
    expect(flat).not.toContain("live-device-token");
    const captured = entry.frame as { auth: { role: string; deviceToken: unknown } };
    expect(captured.auth.role).toBe("operator");
    expect(captured.auth.deviceToken).toEqual({ redacted: true });
  });

  it("drops sessions.changed payloads unless allowAll is set", () => {
    const frame = {
      type: "event",
      event: "sessions.changed",
      payload: { sessions: [{ key: FOREIGN_SESSION, label: "private chat title" }] },
    };
    sink.recordFrame("in", JSON.stringify(frame));
    const [entry] = entries();
    expect(entry.kind).toBe("envelope");
    expect(JSON.stringify(entry)).not.toContain("private chat title");
  });

  it("keeps an unparseable frame raw instead of discarding it", () => {
    sink.recordFrame("in", "not json {{{");
    const [entry] = entries();
    expect(entry.kind).toBe("unparsed");
    expect(entry.raw).toBe("not json {{{");
  });

  it("records marker entries with label and data", () => {
    sink.recordMarker("scenario.start", { scenario: "single-tool" });
    const [entry] = entries();
    expect(entry.kind).toBe("marker");
    expect(entry.label).toBe("scenario.start");
    expect(entry.data).toEqual({ scenario: "single-tool" });
    expect(typeof entry.tMono).toBe("number");
  });

  it("drops frames arriving after close instead of throwing", () => {
    sink.recordFrame("in", JSON.stringify({ type: "tick", ts: 1 }));
    sink.close();
    expect(() => sink.recordFrame("in", JSON.stringify({ type: "tick", ts: 2 }))).not.toThrow();
    expect(() => sink.recordMarker("late")).not.toThrow();
    const written = readFileSync(join(dir, "capture.jsonl"), "utf8").trim().split("\n");
    expect(written.length).toBe(1);
  });

  it("records non-session events like tick in full", () => {
    const frame = { type: "tick", ts: 999 };
    sink.recordFrame("in", JSON.stringify(frame));
    const [entry] = entries();
    expect(entry.kind).toBe("frame");
    expect(entry.frame).toEqual(frame);
  });
});
