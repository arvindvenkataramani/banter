// Writes shared/apis/parts/<api>.json for each API whose pinned reference is
// machine-readable. Run by hand after changing a pin: `bun scripts/generate-api-parts.ts`.
// The prose-referenced indexes (openai.realtime, triton.model-repository,
// fluid.stt.stream, fluid.tts.stream) are written by hand and left alone.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OPENAI_COMMIT = "373f26a9aec3608e3158f2a0d4b8ae49d13162a4";
const DEEPGRAM_COMMIT = "0ccc6f4680b3fe5b8f9002be6a78cd50e5b32116";
const DEEPGRAM_ASYNCAPI_SHA256 = "d3bdcf2771c450d70a2610fffe001c0cf1e9110787fbfee211f53ff59fdda73f";

const OUT = join(import.meta.dir, "..", "shared", "apis", "parts");

type Json = any;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// Deepgram's message keys contain "/" unescaped, so a segment that is not a key
// is joined to the next one until it is.
function lookup(doc: Json, pointer: string): Json {
  const segments = pointer.split("/").slice(1).map(decodeURIComponent);
  let at = doc;
  while (segments.length) {
    let key = segments.shift()!;
    while (!(key in at) && segments.length) key += "/" + segments.shift();
    if (!(key in at)) throw new Error(`unresolved $ref ${pointer}`);
    at = at[key];
  }
  return at;
}

function resolver(doc: Json) {
  const deref = (node: Json): Json => {
    if (!node || typeof node !== "object" || typeof node.$ref !== "string") return node;
    return deref(lookup(doc, node.$ref));
  };
  return deref;
}

// Values are indexed only for a closed set: a plain enum, or a union whose every
// branch is an enum or a const. An open string branch means any value is allowed.
function closedValues(schema: Json, deref: (n: Json) => Json): string[] | null {
  const s = deref(schema);
  if (!s) return null;
  if (Array.isArray(s.enum)) return s.enum.map(String);
  if (s.const !== undefined) return [String(s.const)];
  const branches = s.anyOf ?? s.oneOf;
  if (Array.isArray(branches)) {
    const out: string[] = [];
    for (const b of branches) {
      const v = closedValues(b, deref);
      if (v === null) return null;
      out.push(...v);
    }
    return out;
  }
  if (s.type === "boolean") return ["true", "false"];
  if (s.type === "array" && s.items) return closedValues(s.items, deref);
  return null;
}

function parameterParts(name: string, schema: Json, deref: (n: Json) => Json): string[] {
  const parts = [`parameter:${name}`];
  const values = closedValues(schema, deref);
  if (values) for (const v of values) parts.push(`value:${name}=${v}`);
  return parts;
}

function openaiBodyParts(doc: Json, schemaName: string): string[] {
  const deref = resolver(doc);
  const props = deref(doc.components.schemas[schemaName]).properties as Record<string, Json>;
  return Object.entries(props).flatMap(([name, s]) => parameterParts(name, s, deref));
}

function deepgramQueryParts(doc: Json, path: string): string[] {
  const deref = resolver(doc);
  return (doc.paths[path].post.parameters as Json[])
    .map(deref)
    .filter((p) => p.in === "query")
    .flatMap((p) => parameterParts(p.name, p.schema, deref));
}

// AsyncAPI 2.x describes channels from the application's side: `publish` holds
// what the server sends and `subscribe` what the client sends.
function deepgramChannelParts(doc: Json, channel: string): string[] {
  const deref = resolver(doc);
  const ch = doc.channels[channel];
  const parts: string[] = [];
  const query = ch.bindings?.ws?.query?.properties ?? {};
  for (const [name, s] of Object.entries(query)) parts.push(...parameterParts(name, s, deref));
  const messages = (op: Json): Json[] => (op?.message?.oneOf ?? [op?.message]).filter(Boolean).map(deref);
  const wireName = (m: Json): string => {
    const payload = deref(m.payload);
    const t = payload?.properties?.type ? closedValues(payload.properties.type, deref) : null;
    return t && t.length === 1 ? t[0] : (m.name ?? m.title).replace(/^(Listen|Speak)V1/, "");
  };
  for (const m of messages(ch.subscribe)) parts.push(`client-message:${wireName(m)}`);
  for (const m of messages(ch.publish)) {
    const name = wireName(m);
    parts.push(`server-message:${name}`);
    const props = deref(m.payload)?.properties ?? {};
    for (const field of Object.keys(props)) if (field !== "type") parts.push(`field:${name}.${field}`);
  }
  return parts;
}

async function main() {
  const openai = JSON.parse(await fetchText(`https://raw.githubusercontent.com/openai/openai-openapi/${OPENAI_COMMIT}/openapi.json`));
  const dgOpenapi = Bun.YAML.parse(await fetchText(`https://raw.githubusercontent.com/deepgram/deepgram-api-specs/${DEEPGRAM_COMMIT}/openapi.yml`));
  const asyncText = await fetchText(`https://raw.githubusercontent.com/deepgram/deepgram-api-specs/${DEEPGRAM_COMMIT}/asyncapi.yml`);
  if (sha256(asyncText) !== DEEPGRAM_ASYNCAPI_SHA256) throw new Error("deepgram asyncapi.yml does not match its pinned hash");
  const dgAsync = Bun.YAML.parse(asyncText);

  const indexes: Record<string, { revision: string; parts: string[] }> = {
    "openai.audio.speech": { revision: OPENAI_COMMIT, parts: openaiBodyParts(openai, "CreateSpeechRequest") },
    "openai.audio.transcriptions": { revision: OPENAI_COMMIT, parts: openaiBodyParts(openai, "CreateTranscriptionRequest") },
    "deepgram.listen.prerecorded": { revision: DEEPGRAM_COMMIT, parts: deepgramQueryParts(dgOpenapi, "/v1/listen") },
    "deepgram.speak": { revision: DEEPGRAM_COMMIT, parts: deepgramQueryParts(dgOpenapi, "/v1/speak") },
    "deepgram.listen.live": { revision: DEEPGRAM_COMMIT, parts: deepgramChannelParts(dgAsync, "/v1/listen") },
    "deepgram.speak.live": { revision: DEEPGRAM_COMMIT, parts: deepgramChannelParts(dgAsync, "/v1/speak") },
  };

  await mkdir(OUT, { recursive: true });
  for (const [api, { revision, parts }] of Object.entries(indexes)) {
    const unique = [...new Set(parts)];
    await writeFile(join(OUT, `${api}.json`), JSON.stringify({ api, revision, parts: unique }, null, 2) + "\n");
    console.log(`${api}: ${unique.length} parts`);
  }
}

await main();
