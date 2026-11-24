// The adapter half of fluid-smoke.sh: drives the `deepgram.listen.live` and
// `openai.realtime` adapters, as the voice loop would, against a running
// fluid-stt, one utterance each.
//
//   bun scripts/fluid-smoke-adapters.ts <http://host:port> <file.wav> <expected word> <registry.json> <model key>
//
// For each adapter, in order: the session opens on the provision the registry
// declares; the spoken sentence, streamed at roughly real time and finalized,
// settles in one final that contains the expected word; a second finalize with
// no audio since the first settles in exactly one more final, which is empty.
// Prints one line per check and exits non-zero on the first failure.
//
// The server must already hold <model key> loaded for streaming: the Realtime
// adapter does not load a model by opening a session.
//
// INVENTED: the adapters' call shape is the one the adapter tests share
// (shared/apis/adapters/*.test.ts): `transcribeStream(call, callbacks)` returns
// a session with `sendAudio(ArrayBuffer)`, `finalize()` and `close()`; the
// call is `{ endpoint, provision, model, format }`; the callbacks are
// `onPartial(text)`, `onFinal(text, waitMs)`, `onReady(model, format)` and
// `onClosed(reason, code)`. Reconcile with the adapters when they are built.

import * as listen from "../shared/apis/adapters/deepgram.listen.live";
import * as realtime from "../shared/apis/adapters/openai.realtime";

const [endpoint, wavPath, expected, registryPath, modelKey] = process.argv.slice(2);
if (!endpoint || !wavPath || !expected || !registryPath || !modelKey) {
  console.error(
    "usage: fluid-smoke-adapters.ts <http://host:port> <file.wav> <expected word> <registry.json> <model key>"
  );
  process.exit(2);
}

const FRAME_MS = 100;
const SAMPLE_RATE = 16000;

function fail(message: string): never {
  console.error(`[adapters] FAIL ${message}`);
  process.exit(1);
}

function pass(message: string) {
  console.log(`[adapters] ok   ${message}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The PCM samples of a WAV's data chunk, which `say` does not put at byte 44. */
function pcmOf(wav: Uint8Array): Uint8Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let at = 12;
  while (at + 8 <= wav.byteLength) {
    const id = String.fromCharCode(...wav.subarray(at, at + 4));
    const size = view.getUint32(at + 4, true);
    if (id === "data") return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  fail(`${wavPath} has no data chunk`);
}

/** The provision of `api` in the scratch registry's fluid-stt entry. */
async function provisionOf(api: string): Promise<unknown> {
  const registry = await Bun.file(registryPath).json();
  const entry = (registry.services ?? []).find((s: { id: string }) => s.id === "fluid-stt");
  const provision = (entry?.provides ?? []).find((p: { api: string }) => p.api === api);
  if (!provision) fail(`the fluid-stt entry in ${registryPath} provides no ${api}`);
  return provision;
}

const pcm = pcmOf(new Uint8Array(await Bun.file(wavPath).arrayBuffer()));
const frameBytes = (SAMPLE_RATE * 2 * FRAME_MS) / 1000;

type Final = { text: string; waitMs: number | null };

async function drive(
  name: string,
  adapter: { transcribeStream: (call: any, callbacks: any) => any }
) {
  const provision = await provisionOf(name);
  const finals: Final[] = [];
  const closed: string[] = [];
  let ready = false;

  const session = adapter.transcribeStream(
    { endpoint, provision, model: modelKey, format: "pcm16" },
    {
      onPartial: () => {},
      onFinal: (text: string, waitMs: number | null) => finals.push({ text, waitMs }),
      onReady: () => {
        ready = true;
      },
      onClosed: (reason: string) => closed.push(reason),
    }
  );

  const readyDeadline = Date.now() + 90000;
  while (!ready && closed.length === 0 && Date.now() < readyDeadline) await sleep(50);
  if (closed.length > 0) fail(`${name}: the session closed before it was ready: ${closed[0]}`);
  if (!ready) fail(`${name}: the session was not ready within 90 s`);
  pass(`${name}: the session opened`);

  // One utterance at roughly real time, as a live microphone sends it.
  for (let at = 0; at < pcm.byteLength; at += frameBytes) {
    const frame = pcm.slice(at, at + frameBytes);
    session.sendAudio(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    await sleep(FRAME_MS / 2);
  }
  session.finalize();
  const finalDeadline = Date.now() + 60000;
  while (finals.length < 1 && Date.now() < finalDeadline) await sleep(100);
  if (finals.length < 1) fail(`${name}: the finalize was not answered within 60 s`);
  if (!finals[0].text.toLowerCase().includes(expected.toLowerCase())) {
    fail(`${name}: the final "${finals[0].text}" does not contain "${expected}"`);
  }
  pass(`${name}: one finalize settled "${finals[0].text}"`);

  // A second finalize with nothing sent since the first: one more final, empty.
  session.finalize();
  const emptyDeadline = Date.now() + 30000;
  while (finals.length < 2 && Date.now() < emptyDeadline) await sleep(100);
  if (finals.length < 2) fail(`${name}: a finalize with no audio was not answered within 30 s`);
  await sleep(1500);
  if (finals.length !== 2) fail(`${name}: two finalizes were answered by ${finals.length} finals`);
  if (finals[1].text !== "") fail(`${name}: the answer to an empty finalize carried "${finals[1].text}"`);
  pass(`${name}: one final per finalize, the empty one empty`);

  session.close();
  await sleep(1000);
}

await drive("deepgram.listen.live", listen);
await drive("openai.realtime", realtime);
