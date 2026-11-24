// The vocabulary of declared service APIs (dev/specs/service-apis.md, section 5).

export const API_IDS = [
  "openai.audio.speech",
  "openai.audio.transcriptions",
  "openai.realtime",
  "deepgram.listen.prerecorded",
  "deepgram.listen.live",
  "deepgram.speak",
  "deepgram.speak.live",
  "fluid.stt.stream",
  "fluid.tts.stream",
  "triton.model-repository",
] as const;
export type ApiId = (typeof API_IDS)[number];

export const EXTENSION_IDS = [
  "session-claim",
  "cloning-reference",
  "stream-flag",
  "opus-input",
  "voice-param",
  "verbatim-speech",
  "finalize-answered",
  "endpointing-off",
  "opus-packets",
  "resident-slot",
] as const;
export type ExtensionId = (typeof EXTENSION_IDS)[number];

/** A commit, `"in-repo"` for a document in this repository, or the day a page was read with its hashes. */
export type Revision = string | { read: string; sha256: string | Record<string, string> };
export interface Reference { document: string; revision: Revision; part: string }
export interface CatalogApi { id: ApiId; name: string; reference: Reference }
export interface CatalogExtension { id: ExtensionId; adds: string; reference: Reference }
export interface Catalog { apis: CatalogApi[]; extensions: CatalogExtension[] }
export interface PartIndex { api: ApiId; revision: Revision; parts: string[] }

export type ParamValue = string | number | boolean;

export interface Provision {
  api: ApiId;
  basePath?: string;
  omits?: string[];
  only?: string[];
  restricts?: Record<string, ParamValue[]>;
  defaults?: Record<string, ParamValue>;
  extends?: ExtensionId[];
}

export interface DeclaredCall {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Record<string, string>;
}

/** `autoLoad` and `resident` are stated when `loading` is `required` and absent when it is `none`. */
export interface ModelLoading {
  loading: "required" | "none";
  autoLoad?: "always" | "never";
  resident?: "one" | "many";
  load?: DeclaredCall;
  unload?: DeclaredCall;
}

export type Operation = "synthesize" | "transcribe" | "transcribeStream" | "loadModel" | "unloadModel";

export const CAPABILITIES = [
  "client-endpointing",
  "takeover",
  "opus",
  "renders-progressively",
  "loads-on-request",
  "carries-variant",
  "session-loads",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** A capability rests on a part of the reference, an extension, or the reference's own guarantee.
 *  A basis that names both a part and an extension holds only when both do. */
export type Basis = { part?: string; extension?: ExtensionId; spec?: true };

export interface AdapterDeclaration {
  api: ApiId;
  operations: Operation[];
  /** Part names or extension ids, per operation. */
  requires: Partial<Record<Operation, string[]>>;
  /** Parts and extensions it uses when present, per operation. */
  uses: Partial<Record<Operation, string[]>>;
  /** A capability holds if any basis holds. */
  capabilities: Partial<Record<Capability, Basis[]>>;
}

/** What a service entry offers to selection. */
export interface SelectableService {
  id: string;
  provides?: Provision[];
  models?: ModelLoading;
}
