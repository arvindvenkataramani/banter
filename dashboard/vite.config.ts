import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { execSync } from 'child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import { createHash } from 'node:crypto'

function getCommitSha(): string | null {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() }
  catch { return null }
}

// Pre-compress the large static payload (ORT wasm, ONNX models, JS/CSS) to
// .br + .gz at build time, so the static server can serve a compressed sibling
// without spending CPU per request on the Pi. The 15MB ORT wasm and 8.3MB
// smart-turn model dominate cold-load time; brotli roughly halves the bytes
// on the wire.
//
// Compressed output is cached by content hash outside dist, so the big
// immutable binaries (wasm/onnx) are only ever brotli'd once — subsequent
// deploys copy them straight from the cache instead of re-compressing ~40MB
// of unchanged assets on the Pi every time.
function compressStatic() {
  const exts = new Set(['.wasm', '.onnx', '.js', '.mjs', '.css', '.json', '.svg', '.html'])
  const MIN_BYTES = 1024
  const cacheDir = resolve(import.meta.dirname, 'node_modules/.cache/compress-static')
  let outDir = resolve(import.meta.dirname, 'dist')
  return {
    name: 'compress-static',
    apply: 'build' as const,
    configResolved(config: { root: string; build: { outDir: string } }) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      mkdirSync(cacheDir, { recursive: true })
      let compressed = 0
      let cached = 0

      const emit = (dest: string, cacheKey: string, make: () => Buffer) => {
        const cachePath = resolve(cacheDir, cacheKey)
        if (existsSync(cachePath)) {
          copyFileSync(cachePath, dest)
          cached++
        } else {
          const out = make()
          writeFileSync(cachePath, out)
          writeFileSync(dest, out)
          compressed++
        }
      }

      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = resolve(dir, name)
          const st = statSync(p)
          if (st.isDirectory()) { walk(p); continue }
          if (name.endsWith('.br') || name.endsWith('.gz')) continue
          const ext = name.slice(name.lastIndexOf('.'))
          if (!exts.has(ext) || st.size < MIN_BYTES) continue
          const buf = readFileSync(p)
          const hash = createHash('sha1').update(buf).digest('hex')
          emit(p + '.br', `${hash}.br`, () => brotliCompressSync(buf, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: 9,
              [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length,
            },
          }))
          emit(p + '.gz', `${hash}.gz`, () => gzipSync(buf, { level: 9 }))
        }
      }
      walk(outDir)
      console.log(`[compress-static] ${compressed} compressed, ${cached} from cache`)
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), compressStatic()],
  define: { __COMMIT_SHA__: mode === 'production' ? JSON.stringify(null) : JSON.stringify(getCommitSha()) },
  resolve: { alias: { '@': resolve(import.meta.dirname, './src') } },
  server: {
    host: '127.0.0.1',
    // Cross-origin isolation for multi-threaded WASM, as control/shared/src/static.ts sends in prod.
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    // The proxy passes the Host the request arrived on through unchanged.
    proxy: { '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4200', changeOrigin: false } },
  },
}))
