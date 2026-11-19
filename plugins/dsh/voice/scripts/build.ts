// Builds the installable package into dist/package: the client factory, the
// host entry, the browser assets the host serves and the manifest dsh reads.
//
//   bun scripts/build.ts

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const out = join(dist, 'package')

/** Path prefix the host serves the Vite-emitted client assets under. */
const ASSET_BASE = '/dsh-voice/'

/** dsh's shared module table: left as `require` calls in the client bundle (packages/client/web/src/platform.ts:8). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', 'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string }

await rm(dist, { recursive: true, force: true })

// Client: one CommonJS script in dsh's client module format
// (packages/client/tsdown.client.ts:932-938), assets emitted as files.
await build({
  configFile: false,
  root,
  base: ASSET_BASE,
  logLevel: 'warn',
  define: { 'import.meta.url': 'document.baseURI' },
  build: {
    outDir: join(dist, 'client'),
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 0,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      input: join(root, 'src/client/index.tsx'),
      external: PLATFORM_MODULES,
      // Radix's modules open with "use client", which a plain script has no use for.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning)
      },
      preserveEntrySignatures: 'exports-only',
      output: {
        format: 'cjs',
        exports: 'named',
        codeSplitting: false,
        entryFileNames: 'client.js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });',
      },
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
})

// Host: one ESM file for Node. dsh's own packages stay external; they resolve
// from the running installation.
await build({
  configFile: false,
  root,
  logLevel: 'warn',
  build: {
    ssr: join(root, 'src/host/index.ts'),
    outDir: join(dist, 'host'),
    emptyOutDir: true,
    target: 'node24',
    sourcemap: false,
    minify: false,
    rollupOptions: { external: ['@deepseek-ai/schemastery'], output: { format: 'esm', entryFileNames: 'index.js' } },
  },
  ssr: { noExternal: true, external: ['@deepseek-ai/schemastery'] },
})

await mkdir(out, { recursive: true })
await cp(join(dist, 'client/client.js'), join(out, 'client.js'))
await mkdir(join(out, 'assets'), { recursive: true })
if (existsSync(join(dist, 'client/assets'))) await cp(join(dist, 'client/assets'), join(out, 'assets'), { recursive: true })
await cp(join(dist, 'host/index.js'), join(out, 'index.js'))
await cp(resolve(root, '../../../dashboard/public/models'), join(out, 'public/models'), { recursive: true, filter: source => !/\.(br|gz)$/.test(source) })
await cp(resolve(root, '../../../dashboard/public/tones'), join(out, 'public/tones'), { recursive: true, filter: source => !/\.(br|gz)$/.test(source) })

// dsh's plugin page shows the package's README when no locale detail is given.
await cp(join(root, 'README.md'), join(out, 'README.md'))
await writeFile(join(out, 'cordis.patch.yml'), `- insert:\n    - id: dsh-voice\n      name: '${pkg.name}'\n`)
await writeFile(join(out, 'package.json'), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  type: 'module',
  main: 'index.js',
  exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
  files: ['index.js', 'client.js', 'assets', 'public', 'cordis.patch.yml', 'README.md'],
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-api-session-controller',
        '@deepseek-ai/dsh-client-ui-conversation',
        '@deepseek-ai/dsh-client-ui-layout',
        '@deepseek-ai/dsh-client-ui-settings',
      ],
    },
  },
  engines: { dsh: '>=0.2.2-rc.1 <0.3.0' },
  peerDependencies: { '@deepseek-ai/cordis': '~4.1.0', '@deepseek-ai/schemastery': '~3.19.0' },
}, null, 2)}\n`)

console.log(`built ${out}`)
