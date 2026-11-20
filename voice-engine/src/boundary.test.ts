import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

// The package is consumed by more than one host, so it may import only its
// own files and the dependencies its package.json declares.

const srcDir = dirname(new URL(import.meta.url).pathname)
const pkg = JSON.parse(readFileSync(join(srcDir, '..', 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})])
const builtins = new Set(builtinModules)

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js)$/.test(name) ? [path] : []
  })
}

const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g

function packageName(specifier: string): string {
  const bare = specifier.split('?')[0]
  const parts = bare.split('/')
  return bare.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function violations(): string[] {
  const found: string[] = []
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match[1] ?? match[2] ?? match[3]
      const where = `${relative(srcDir, file)}: ${spec}`
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec.split('?')[0])
        if (target !== srcDir && !target.startsWith(srcDir + '/')) found.push(where)
      } else if (!spec.startsWith('node:') && !builtins.has(spec) && !declared.has(packageName(spec))) {
        found.push(where)
      }
    }
  }
  return found
}

describe('voice-engine package boundary', () => {
  it('the engine and its tests are present in the package', () => {
    expect(sourceFiles(srcDir).some((f) => f.endsWith('/index.ts'))).toBe(true)
  })

  it('no file imports outside the package except declared dependencies and Node builtins', () => {
    expect(violations()).toEqual([])
  })
})
