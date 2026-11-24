import { failure, trimEndpoint } from "./http";
import type { AdapterDeclaration, AudioFormat, Provision, Resolution } from "../types";

export const declaration: AdapterDeclaration = {
  api: "openai.audio.speech",
  operations: ["synthesize"],
  requires: { synthesize: ["parameter:input", "parameter:response_format"] },
  uses: { synthesize: ["parameter:voice", "parameter:speed", "cloning-reference", "stream-flag"] },
  capabilities: {
    "renders-progressively": [{ spec: true }, { extension: "stream-flag" }],
  },
};

export interface SynthesizeCall {
  endpoint: string;
  provision: Provision;
  text: string;
  resolution: Resolution;
  speed: number;
  /** The caller wants audio as it renders. */
  progressive?: boolean;
  signal?: AbortSignal;
}

/** The answer, whose body is audio in `format`. */
export interface Synthesized {
  format: AudioFormat;
  response: Response;
}

// The formats the caller decodes, in the order tried when the provision restricts none.
const DECODABLE: readonly AudioFormat[] = ["mp3", "aac", "wav"];

/** The first value the provision accepts that the caller decodes, in the restriction's own order. */
function chooseFormat(provision: Provision): AudioFormat {
  const accepted = provision.restricts?.response_format?.map(String);
  const format = accepted ? accepted.find((f): f is AudioFormat => (DECODABLE as readonly string[]).includes(f)) : DECODABLE[0];
  if (!format) throw new Error(`The speech service accepts ${accepted!.join(", ")}; none of them is a format this player decodes (${DECODABLE.join(", ")}).`);
  return format;
}

/** The speech request body: the serving's own parameters first, so the adapter's fields win. */
function bodyFor(call: SynthesizeCall, format: AudioFormat): Record<string, unknown> {
  const { provision, resolution } = call;
  const body: Record<string, unknown> = {
    ...resolution.params,
    model: resolution.model,
    input: call.text,
    speed: call.speed,
    response_format: format,
  };
  if ("name" in resolution.voice) {
    body.voice = resolution.voice.name;
  } else {
    if (!provision.extends?.includes("cloning-reference")) {
      throw new Error("This voice is a recording, and the speech service does not declare cloning-reference.");
    }
    body.ref_audio = resolution.voice.recording;
    if (resolution.voice.transcript !== undefined) body.ref_text = resolution.voice.transcript;
  }
  if (call.progressive && provision.extends?.includes("stream-flag")) body.stream = true;
  return body;
}

export async function synthesize(call: SynthesizeCall): Promise<Synthesized> {
  const format = chooseFormat(call.provision);
  const body = bodyFor(call, format);
  const url = `${trimEndpoint(call.endpoint)}${call.provision.basePath ?? "/v1"}/audio/speech`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: call.signal,
  });
  if (!response.ok) throw await failure(response);
  return { format, response };
}
