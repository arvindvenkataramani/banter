import type { AdapterDeclaration } from "../types";

export const declaration: AdapterDeclaration = {
  api: "deepgram.listen.live",
  operations: ["transcribeStream"],
  requires: {
    transcribeStream: ["client-message:Finalize", "server-message:Results", "parameter:endpointing"],
  },
  uses: {
    transcribeStream: [
      "client-message:KeepAlive",
      "client-message:CloseStream",
      "parameter:model",
      "finalize-answered",
      "session-claim",
      "opus-packets",
    ],
  },
  capabilities: {
    "client-endpointing": [{ extension: "endpointing-off" }],
    // Opus packets are carried only when `opus` has not been restricted out of `encoding`.
    opus: [{ extension: "opus-packets", part: "value:encoding=opus" }],
    takeover: [{ extension: "session-claim" }],
    "session-loads": [{ part: "parameter:model" }],
  },
};
