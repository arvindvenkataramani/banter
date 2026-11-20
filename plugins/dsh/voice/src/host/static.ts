// Serves files from one directory of the built package, by URL path, with the
// content types the browser needs (wasm must be application/wasm).

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const CONTENT_TYPES: Record<string, string> = {
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
}

/** The file below `root` that `relativePath` names, or null when it escapes `root` or is not a regular file. */
export async function resolveStaticFile(root: string, relativePath: string): Promise<{ file: string; size: number; mtimeMs: number } | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(relativePath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const file = normalize(join(root, decoded))
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return null
  try {
    const info = await stat(file)
    return info.isFile() ? { file, size: info.size, mtimeMs: info.mtimeMs } : null
  } catch {
    return null
  }
}

/** Answers GET and HEAD for `relativePath` under `root`; 404 for anything else, 405 for other methods. */
export async function serveStatic(root: string, relativePath: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end()
    return
  }
  const found = await resolveStaticFile(root, relativePath)
  const type = found === null ? undefined : CONTENT_TYPES[extname(found.file)]
  if (found === null || type === undefined) {
    res.writeHead(404).end()
    return
  }
  const etag = `"${found.size.toString(16)}-${Math.floor(found.mtimeMs).toString(16)}"`
  const headers = {
    'content-type': type,
    'content-length': found.size,
    etag,
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end()
    return
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(found.file).on('error', () => { res.destroy() }).pipe(res)
}
