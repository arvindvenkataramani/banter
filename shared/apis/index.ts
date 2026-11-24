// The adapter registry: API id to adapter. An API with no entry has no adapter, so no
// operation is performed over it. An adapter is its declaration beside the functions
// that perform its operations.

import type { AdapterDeclaration, ApiId } from "./types";
import * as speech from "./adapters/openai.audio.speech";
import * as transcriptions from "./adapters/openai.audio.transcriptions";
import { declaration as realtime } from "./adapters/openai.realtime";
import { declaration as listenLive } from "./adapters/deepgram.listen.live";
import * as sttStream from "./adapters/fluid.stt.stream";
import * as modelRepository from "./adapters/triton.model-repository";

export interface Adapter extends AdapterDeclaration {
  synthesize?: typeof speech.synthesize;
  transcribe?: typeof transcriptions.transcribe;
  transcribeStream?: typeof sttStream.transcribeStream;
  /** The WebSocket path of a streaming provision, below the endpoint. */
  streamPath?: typeof sttStream.streamPath;
  loadModel?: typeof modelRepository.loadModel;
  unloadModel?: typeof modelRepository.unloadModel;
}

export const adapters: Partial<Record<ApiId, Adapter>> = {
  "openai.audio.speech": { ...speech.declaration, synthesize: speech.synthesize },
  "openai.audio.transcriptions": { ...transcriptions.declaration, transcribe: transcriptions.transcribe },
  "openai.realtime": realtime,
  "deepgram.listen.live": listenLive,
  "fluid.stt.stream": { ...sttStream.declaration, transcribeStream: sttStream.transcribeStream, streamPath: sttStream.streamPath },
  "triton.model-repository": { ...modelRepository.declaration, loadModel: modelRepository.loadModel, unloadModel: modelRepository.unloadModel },
};

export const adapterFor = (api: string): Adapter | undefined => adapters[api as ApiId];
