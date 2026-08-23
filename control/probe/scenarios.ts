// Scripted chats designed so tool calls definitely occur.
//
// Each scenario names the shape it is trying to produce, not the tool it
// expects the agent to pick — the agent chooses its own tools, and a prompt
// that over-specifies would test our guess rather than the protocol.

export interface Scenario {
  id: string;
  /** What this scenario is meant to reveal about the wire. */
  intent: string;
  prompt: string;
  /** Extra seconds to wait beyond the default, for slow scenarios. */
  extraWaitMs?: number;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "single-tool",
    intent: "One tool call in a turn: baseline ordering of tool vs message events.",
    prompt:
      "Run the shell command `echo probe-single` and tell me exactly what it printed. " +
      "Use your shell tool — do not answer from memory.",
  },
  {
    id: "multi-tool",
    intent:
      "Several tool calls in one turn: whether every call appears, and whether " +
      "session.message rolls earlier blocks out as observed in 2026-05.",
    prompt:
      "Run these four shell commands one at a time, in order, and report each result: " +
      "`echo one`, then `echo two`, then `echo three`, then `echo four`. " +
      "Use a separate tool call for each.",
  },
  {
    id: "text-slow-tool-text",
    intent:
      "THE PRIORITY MEASUREMENT. Text, then a slow tool, then more text — so the " +
      "silent pause is unambiguous and stream:tool, session.message and the last " +
      "chat delta can all be timed against one boundary.",
    prompt:
      "First, in two or three sentences, tell me what you are about to do. " +
      "Then run the shell command `sleep 8 && echo probe-slow-done`. " +
      "Then, after it finishes, tell me in two or three sentences what it returned.",
    extraWaitMs: 15_000,
  },
  {
    id: "command-output",
    intent:
      "Long-running tool with incremental stdout: whether command_output deltas " +
      "arrive during the tool rather than only at its end.",
    prompt:
      "Run this shell command and report what it printed: " +
      "`for i in 1 2 3 4 5; do echo tick-$i; sleep 2; done`",
    extraWaitMs: 20_000,
  },
  {
    id: "patch",
    intent: "File edit: whether a patch stream event carries added/modified/deleted.",
    prompt:
      "Create a file at /tmp/probe-patch-test.md containing a single line of text, " +
      "then edit that file to add a second line. Use your file editing tools.",
    extraWaitMs: 10_000,
  },
  {
    id: "read-dir",
    intent:
      "Filesystem read over a real directory tree. Whether a read-shaped tool " +
      "emits the same streams as exec, or a different set.",
    // Deliberately asks for the agent's own working directory rather than naming
    // a path: the probe only needs *a* real tree to read, and hardcoding one
    // makes the scenario fail on any gateway whose agent is laid out differently.
    // Override with PROBE_READ_DIR to point at a specific tree.
    prompt:
      `Look in ${process.env.PROBE_READ_DIR ?? "your working directory"} and tell me what ` +
      "is in there — list the top-level entries and summarise one file you find. " +
      "Use your file tools.",
    extraWaitMs: 15_000,
  },
  {
    id: "memory-search",
    intent:
      "Memory search. A retrieval tool rather than a shell tool — whether it " +
      "reports through stream:tool/item at all, and whether args are redacted.",
    prompt:
      "Search your memory for anything about the platform control plane or the " +
      "voice interface, and tell me what you find.",
    extraWaitMs: 15_000,
  },
  {
    id: "session-history",
    intent:
      "Past-session lookup. Reads gateway state rather than the filesystem, so " +
      "it may take a different path to the event bus.",
    prompt:
      "Look at my recent sessions and tell me what the last few were about.",
    extraWaitMs: 15_000,
  },
  {
    id: "tool-listing",
    intent:
      "Introspection. Fast and metadata-only — a lower bound on how small a " +
      "tool interaction can be while still producing events.",
    prompt: "What tools do you have available? List them.",
    extraWaitMs: 10_000,
  },
  {
    id: "email-check",
    intent:
      "Skill-backed tool (himalaya). Goes out to an external service, so it is " +
      "the slowest realistic tool and the one most likely to expose a distinct " +
      "path to the event bus.",
    prompt: "Check my email and tell me what's in the inbox — just the recent subjects.",
    extraWaitMs: 30_000,
  },
  {
    id: "calendar-check",
    intent:
      "Another external-service tool, for whether provider-specific tools vary " +
      "in what they report.",
    prompt: "What's on my calendar today?",
    extraWaitMs: 30_000,
  },
  {
    id: "approval",
    intent:
      "Approval prompt: whether an approval event reaches an operator client and " +
      "what it carries. May not trigger if the agent's exec policy auto-approves.",
    prompt:
      "Run the shell command `rm -f /tmp/probe-approval-target` and tell me the result.",
    extraWaitMs: 10_000,
  },
];

/** Scenarios run by default, in order. */
export const DEFAULT_SCENARIO_IDS = SCENARIOS.map((s) => s.id);

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
