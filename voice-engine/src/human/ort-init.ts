import type * as Ort from 'onnxruntime-web/wasm'
import ortModuleUrl from 'onnxruntime-web/wasm?url'
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'

export type { Ort }

let loading: Promise<typeof Ort> | null = null

/**
 * The one ORT instance both voice models share. ORT's prebuilt module is
 * emitted as an asset and imported by URL at runtime, never bundled: each
 * worker thread ORT starts loads the module ORT's code lives in, and any chunk
 * the bundler writes may import the app's main chunk, which fails on `document`
 * inside a worker and leaves session creation hung. The prebuilt file imports
 * nothing. Being unbundled, it cannot find its .wasm itself, so wasmPaths
 * names the asset.
 *
 * Multi-threaded WASM needs SharedArrayBuffer, which only a cross-origin
 * isolated page has; the dashboard's server sends COOP/COEP for it. Four
 * threads measured fastest on a four-core iPhone, where ORT's own default
 * (half the cores) would give two. Without isolation, one thread, the only
 * count that works there.
 */
export function loadOrt(): Promise<typeof Ort> {
  loading ??= (import(/* @vite-ignore */ ortModuleUrl) as Promise<typeof Ort>).then((ort) => {
    ort.env.wasm.wasmPaths = { wasm: ortWasmUrl }
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1
    return ort
  })
  return loading
}
