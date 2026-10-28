// The WebSocket half of fluid-smoke.sh: streams a 16 kHz mono WAV to a running
// fluid-stt's Deepgram /listen socket and checks what comes back.
//
//   bun scripts/fluid-smoke-listen.ts <ws://host:port> <file.wav> <expected word>
//
// Checks, in order: the socket opens; a second socket opened during the session
// is refused without displacing the first; a pause after speech closes the
// utterance with a final that contains the expected word; CloseStream answers
// with Metadata. Prints one line per check and exits non-zero on the first
// failure.

const [base, wavPath, expected] = process.argv.slice(2);
if (!base || !wavPath || !expected) {
  console.error("usage: fluid-smoke-listen.ts <ws://host:port> <file.wav> <expected word>");
  process.exit(2);
}

const SAMPLE_RATE = 16000;
const FRAME_MS = 100;
const QUERY = `encoding=linear16&sample_rate=${SAMPLE_RATE}&channels=1&endpointing=700`;

function fail(message: string): never {
  console.error(`[listen] FAIL ${message}`);
  process.exit(1);
}

function pass(message: string) {
  console.log(`[listen] ok   ${message}`);
}

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

type Message = { type?: string; is_final?: boolean; from_finalize?: boolean; channel?: any };

function open(url: string): Promise<{ ws: WebSocket; messages: Message[]; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const messages: Message[] = [];
    let onClose: (code: number) => void;
    const closed = new Promise<number>(r => (onClose = r));
    ws.onmessage = e => {
      if (typeof e.data === "string") messages.push(JSON.parse(e.data));
    };
    ws.onclose = e => onClose(e.code);
    ws.onopen = () => resolve({ ws, messages, closed });
    ws.onerror = () => reject(new Error(`could not open ${url}`));
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, sleep(ms).then(() => undefined)]);

const pcm = pcmOf(new Uint8Array(await Bun.file(wavPath).arrayBuffer()));
const frameBytes = (SAMPLE_RATE * 2 * FRAME_MS) / 1000;
const silence = new Uint8Array(frameBytes);

const first = await open(`${base}/listen?${QUERY}`).catch(e => fail(String(e)));
pass("socket opened");

// Speech at roughly real time, so the server sees what a live client sends.
for (let at = 0; at < pcm.byteLength; at += frameBytes) {
  first.ws.send(pcm.subarray(at, at + frameBytes));
  await sleep(FRAME_MS / 2);
}

// Then silence, as a live microphone would send. Audio sent while the server
// is still loading waits in the socket, so results can lag the speech by a
// whole load; until they arrive the first socket may hold no session yet.
// Silence past the endpointing pause also closes the utterance.
const sendSilenceUntil = async (done: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) {
    first.ws.send(silence);
    await sleep(FRAME_MS / 2);
  }
  return done();
};
if (!(await sendSilenceUntil(() => first.messages.some(m => m.type === "Results"), 90000))) {
  fail("no results within 90 s of the speech");
}

// Only now, with the session provably held, is a second socket a second client
// rather than a rival for an unclaimed session.
const second = await open(`${base}/listen?${QUERY}`).catch(() => undefined);
if (second) {
  const code = await within(second.closed, 5000);
  if (code === undefined) {
    fail(
      `a second socket stayed open during a session (readyState ${second.ws.readyState}, ` +
        `received ${JSON.stringify(second.messages)})`
    );
  }
  if (second.messages.some(m => m.type === "Results")) fail("a second socket received results");
}
if (first.ws.readyState !== WebSocket.OPEN) fail("the first socket was displaced by the second");
pass("a second socket was refused and the first kept its session");

const isFinal = (m: Message) => m.type === "Results" && m.is_final === true;
if (!(await sendSilenceUntil(() => first.messages.some(isFinal), 15000))) {
  fail("no final after the endpointing pause");
}
const final = first.messages.find(isFinal)!;
if (final.from_finalize) fail("the final was attributed to Finalize, not the pause");
const transcript: string = final.channel?.alternatives?.[0]?.transcript ?? "";
if (!transcript.toLowerCase().includes(expected.toLowerCase())) {
  fail(`the final "${transcript}" does not contain "${expected}"`);
}
pass(`the pause closed the utterance: "${transcript}"`);

first.ws.send(JSON.stringify({ type: "CloseStream" }));
const closeDeadline = Date.now() + 10000;
while (!first.messages.some(m => m.type === "Metadata") && Date.now() < closeDeadline) await sleep(100);
if (!first.messages.some(m => m.type === "Metadata")) fail("CloseStream got no Metadata");
first.ws.close();
await within(first.closed, 5000);
pass("CloseStream answered with Metadata");
