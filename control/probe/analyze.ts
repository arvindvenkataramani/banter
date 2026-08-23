// Capture analysis: per-scenario timelines and tool-boundary timing.
//
//   bun run control/probe/analyze.ts <capture.jsonl> [--timeline]
//
// For every stream:"tool" start event it reports, relative to that boundary:
//   - the last chat delta before it (how stale the text stream was)
//   - the session.message that committed the pre-tool text, if any
//   - the first session.message carrying a toolCall/tool_use block for the
//     same toolCallId (what the dashboard's current scraping path waits for)
//   - the matching tool result/end event (tool duration)
// Negative lead means the comparison event never arrived.

interface Entry {
  kind: string;
  dir?: string;
  tMono: number;
  tWall: number;
  label?: string;
  data?: Record<string, unknown>;
  frame?: {
    type?: string;
    event?: string;
    payload?: {
      sessionKey?: string;
      runId?: string;
      seq?: number;
      state?: string;
      stream?: string;
      messageSeq?: number;
      message?: { role?: string; content?: unknown };
      data?: Record<string, unknown>;
    };
  };
}

function fmt(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  return `${sign}${Math.abs(ms).toFixed(0)}ms`;
}

function contentBlocks(message: { content?: unknown } | undefined): Record<string, unknown>[] {
  const content = message?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function toolCallBlocks(entry: Entry): Record<string, unknown>[] {
  return contentBlocks(entry.frame?.payload?.message).filter(
    (b) => b.type === "toolCall" || b.type === "tool_use",
  );
}

function blockToolCallId(block: Record<string, unknown>): string | undefined {
  for (const key of ["toolCallId", "id", "tool_use_id"]) {
    if (typeof block[key] === "string") return block[key] as string;
  }
  return undefined;
}

async function main() {
  const [path, ...flags] = process.argv.slice(2);
  if (!path) {
    console.error("usage: bun run control/probe/analyze.ts <capture.jsonl> [--timeline]");
    process.exit(1);
  }
  const showTimeline = flags.includes("--timeline");

  const text = await Bun.file(path).text();
  const entries: Entry[] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  // Slice into scenario sections by markers; everything before the first
  // scenario.start is setup and ignored for stats.
  let scenario = "(setup)";
  const sections = new Map<string, Entry[]>();
  for (const entry of entries) {
    if (entry.kind === "marker" && entry.label === "scenario.start") {
      scenario = String(entry.data?.scenario ?? "unknown");
    }
    if (!sections.has(scenario)) sections.set(scenario, []);
    sections.get(scenario)!.push(entry);
    if (entry.kind === "marker" && entry.label === "scenario.end") {
      scenario = "(between)";
    }
  }

  for (const [name, section] of sections) {
    if (name === "(setup)" || name === "(between)") continue;
    console.log(`\n=== ${name} ===`);

    if (showTimeline) {
      for (const e of section) {
        const p = e.frame?.payload;
        const what =
          e.kind === "marker"
            ? `· ${e.label}`
            : `${e.frame?.event ?? e.frame?.type}${p?.stream ? `/${p.stream}` : ""}` +
              `${p?.data?.phase ? `:${p.data.phase}` : ""}${p?.state ? `:${p.state}` : ""}`;
        console.log(`  ${e.tMono.toFixed(0).padStart(8)}  ${e.dir ?? " "}  ${what}`);
      }
    }

    const toolStarts = section.filter(
      (e) => e.frame?.payload?.stream === "tool" && e.frame?.payload?.data?.phase === "start",
    );
    if (toolStarts.length === 0) {
      console.log("  no tool start events");
      continue;
    }

    for (const start of toolStarts) {
      const t0 = start.tMono;
      const callId = String(start.frame?.payload?.data?.toolCallId ?? "");
      const toolName = String(start.frame?.payload?.data?.name ?? "?");

      const lastDeltaBefore = section
        .filter(
          (e) => e.frame?.event === "chat" && e.frame?.payload?.state === "delta" && e.tMono < t0,
        )
        .at(-1);

      const textCommitBefore = section
        .filter(
          (e) =>
            e.frame?.event === "session.message" &&
            e.frame?.payload?.message?.role === "assistant" &&
            e.tMono < t0,
        )
        .at(-1);

      const toolCallMessage = section.find(
        (e) =>
          e.frame?.event === "session.message" &&
          e.tMono >= t0 - 50 &&
          toolCallBlocks(e).some((b) => !callId || blockToolCallId(b) === callId),
      );

      const end = section.find(
        (e) =>
          e.frame?.payload?.stream === "tool" &&
          e.tMono > t0 &&
          ["result", "end"].includes(String(e.frame?.payload?.data?.phase)) &&
          (!callId || e.frame?.payload?.data?.toolCallId === callId),
      );

      console.log(`  tool ${toolName} (${callId.slice(0, 18) || "no id"}) at ${t0.toFixed(0)}ms`);
      console.log(
        `    last chat delta before start:      ${
          lastDeltaBefore ? fmt(lastDeltaBefore.tMono - t0) : "none"
        }`,
      );
      console.log(
        `    pre-tool text commit (sess.msg):   ${
          textCommitBefore ? fmt(textCommitBefore.tMono - t0) : "none"
        }`,
      );
      console.log(
        `    toolCall block in session.message: ${
          toolCallMessage ? fmt(toolCallMessage.tMono - t0) : "NEVER during capture"
        }`,
      );
      console.log(
        `    tool result/end:                   ${end ? fmt(end.tMono - t0) : "not captured"}`,
      );
    }

    const phases = new Map<string, number>();
    for (const e of section) {
      const p = e.frame?.payload;
      if (!p?.stream) continue;
      const key = `${p.stream}:${String(p.data?.phase ?? p.state ?? "")}`;
      phases.set(key, (phases.get(key) ?? 0) + 1);
    }
    console.log(
      `  agent streams seen: ${[...phases.entries()].map(([k, n]) => `${k}×${n}`).join("  ")}`,
    );
  }
}

await main();
