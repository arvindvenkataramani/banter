// The adapter registry: API id to adapter. An API with no entry has no adapter, so no
// operation is performed over it.

import type { AdapterDeclaration, ApiId } from "./types";
import { declaration as speech } from "./adapters/openai.audio.speech";
import { declaration as transcriptions } from "./adapters/openai.audio.transcriptions";
import { declaration as realtime } from "./adapters/openai.realtime";
import { declaration as listenLive } from "./adapters/deepgram.listen.live";
import { declaration as sttStream } from "./adapters/fluid.stt.stream";
import { declaration as modelRepository } from "./adapters/triton.model-repository";

export type Adapter = AdapterDeclaration;

export const adapters: Partial<Record<ApiId, Adapter>> = {
  "openai.audio.speech": speech,
  "openai.audio.transcriptions": transcriptions,
  "openai.realtime": realtime,
  "deepgram.listen.live": listenLive,
  "fluid.stt.stream": sttStream,
  "triton.model-repository": modelRepository,
};

export const adapterFor = (api: string): Adapter | undefined => adapters[api as ApiId];
