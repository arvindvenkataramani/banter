import { failure, trimEndpoint } from "./http";
import type { AdapterDeclaration, Provision } from "../types";

export const declaration: AdapterDeclaration = {
  api: "openai.audio.transcriptions",
  operations: ["transcribe"],
  requires: { transcribe: ["parameter:file"] },
  uses: { transcribe: ["parameter:model", "parameter:response_format"] },
  capabilities: {},
};

export interface TranscribeCall {
  endpoint: string;
  provision: Provision;
  /** A WAV recording. */
  audio: ArrayBuffer;
  /** The serving's key, when the caller names a model. */
  model?: string;
}

/** Posts the recording as multipart `file` and resolves to the transcript's text. */
export async function transcribe(call: TranscribeCall): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([call.audio], { type: "audio/wav" }), "audio.wav");
  if (call.model) form.append("model", call.model);

  const url = `${trimEndpoint(call.endpoint)}${call.provision.basePath ?? "/v1"}/audio/transcriptions`;
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw await failure(res);
  const data = (await res.json()) as { text?: string };
  return data.text ?? "";
}
