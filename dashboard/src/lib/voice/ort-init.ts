import * as ort from 'onnxruntime-web'
import * as ortExp from 'onnxruntime-web/experimental'

// Force single-threaded WASM on both bundles. Multi-threaded WASM requires
// SharedArrayBuffer which requires COOP/COEP headers — not set in dev or prod.
// Must be set at module load time; ORT initializes WASM on first import, not on
// InferenceSession.create(). Enabling multi-threading means serving both headers
// and re-testing every model path that touches WASM.
ort.env.wasm.numThreads = 1
ort.env.wasm.wasmPaths = '/models/'
ortExp.env.wasm.numThreads = 1
ortExp.env.wasm.wasmPaths = '/models/'
