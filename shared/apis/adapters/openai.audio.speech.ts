import type { AdapterDeclaration } from "../types";

export const declaration: AdapterDeclaration = {
  api: "openai.audio.speech",
  operations: ["synthesize"],
  requires: { synthesize: ["parameter:input", "parameter:response_format"] },
  uses: { synthesize: ["parameter:voice", "parameter:speed", "cloning-reference", "stream-flag"] },
  capabilities: {
    "renders-progressively": [{ spec: true }, { extension: "stream-flag" }],
  },
};
