import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { execSync } from 'child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import { createHash } from 'node:crypto'

function getCommitSha(): string | null {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() }
  catch { return null }
}

// onnxruntime-web loads its WASM runtime from ort.env.wasm.wasmPaths = '/models/'
// (see src/lib/voice/ort-init.ts), so those binaries must be served at /models/.
// They ship inside the npm package, not in git — public/models/*.wasm and
// *.mjs are .gitignored (unlike the model assets beside them, which are
// committed). Production deploys via `git archive` (control-deploy.sh), which
// drops ignored files, so without this step the wasm never lands in dist/models/
// and VAD/SmartTurn silently fail to load in prod (works in dev only because the
// dev server serves the wasm sitting in the working tree). Copy the
// version-matched binaries out of node_modules at build start so the build is
// self-contained regardless of deploy source.
function copyOrtWasm() {
  return {
    name: 'copy-ort-wasm',
    buildStart() {
      const require = createRequire(import.meta.url)
      const entry = require.resolve('onnxruntime-web')
      const marker = 'onnxruntime-web'
      const pkgRoot = entry.slice(0, entry.lastIndexOf(marker) + marker.length)
      const distDir = resolve(pkgRoot, 'dist')
      const outDir = resolve(__dirname, 'public/models')
      mkdirSync(outDir, { recursive: true })
      const files = readdirSync(distDir).filter(f => f.endsWith('.wasm') || f.endsWith('.mjs'))
      if (files.length === 0) throw new Error(`[copy-ort-wasm] no ORT wasm found in ${distDir}`)
      for (const f of files) copyFileSync(resolve(distDir, f), resolve(outDir, f))
      console.log(`[copy-ort-wasm] copied ${files.length} ORT runtime files from ${distDir} → public/models/`)
    },
  }
}

// Pre-compress the large static payload (ORT wasm, ONNX models, JS/CSS) to
// .br + .gz at build time, so the static server can serve a compressed sibling
// without spending CPU per request on the Pi. The 11MB ORT wasm and 8.3MB
// smart-turn model dominate cold-load time; brotli roughly halves the bytes
// on the wire.
//
// Compressed output is cached by content hash outside dist, so the big
// immutable binaries (wasm/onnx) are only ever brotli'd once — subsequent
// deploys copy them straight from the cache instead of re-compressing ~40MB
// of unchanged assets on the Pi every time.
function compressStatic() {
  const exts = new Set(['.wasm', '.onnx', '.js', '.css', '.json', '.svg', '.html'])
  const MIN_BYTES = 1024
  const cacheDir = resolve(__dirname, 'node_modules/.cache/compress-static')
  return {
    name: 'compress-static',
    apply: 'build' as const,
    closeBundle() {
      mkdirSync(cacheDir, { recursive: true })
      const outDir = resolve(__dirname, 'dist')
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
  plugins: [react(), tailwindcss(), copyOrtWasm(), compressStatic()],
  define: { __COMMIT_SHA__: mode === 'production' ? JSON.stringify(null) : JSON.stringify(getCommitSha()) },
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:4200' },
  },
}))
