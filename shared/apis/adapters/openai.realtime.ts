import type { AdapterDeclaration } from "../types";

export const declaration: AdapterDeclaration = {
  api: "openai.realtime",
  operations: ["transcribeStream"],
  requires: {
    transcribeStream: [
      "mode:transcription",
      "client-message:session.update",
      "client-message:input_audio_buffer.append",
      "client-message:input_audio_buffer.commit",
      "server-message:input_audio_buffer.committed",
      "server-message:conversation.item.input_audio_transcription.completed",
    ],
  },
  uses: {
    transcribeStream: [
      "server-message:conversation.item.input_audio_transcription.delta",
      "client-message:input_audio_buffer.clear",
      "opus-input",
    ],
  },
  capabilities: {
    "client-endpointing": [{ spec: true }],
    opus: [{ extension: "opus-input" }],
  },
};
