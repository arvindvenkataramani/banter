import type { AdapterDeclaration } from "../types";

export const declaration: AdapterDeclaration = {
  api: "openai.audio.transcriptions",
  operations: ["transcribe"],
  requires: { transcribe: ["parameter:file"] },
  uses: { transcribe: ["parameter:model", "parameter:response_format"] },
  capabilities: {},
};
