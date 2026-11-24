import type { AdapterDeclaration } from "../types";

export const declaration: AdapterDeclaration = {
  api: "fluid.stt.stream",
  operations: ["transcribeStream"],
  requires: { transcribeStream: ["client-message:Finalize", "server-message:transcript"] },
  uses: { transcribeStream: ["parameter:session", "parameter:takeover", "parameter:chunkMs", "value:format=opus"] },
  capabilities: {
    "client-endpointing": [{ spec: true }],
    opus: [{ spec: true }],
    takeover: [{ part: "parameter:session" }],
    "carries-variant": [{ part: "parameter:chunkMs" }],
    "session-loads": [{ spec: true }],
  },
};
