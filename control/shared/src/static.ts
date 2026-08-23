import { join, extname } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".onnx": "application/octet-stream",
  ".svg": "image/svg+xml",
};

export async function serveStatic(distPath: string, req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = join(distPath, pathname);
  if (await Bun.file(filePath).exists()) {
    return respond(filePath, pathname, req);
  }
  // SPA fallback — never cache the HTML shell so deploys take effect.
  return new Response(Bun.file(join(distPath, "index.html")), {
    headers: { "Cache-Control": "no-cache" },
  });
}

async function respond(filePath: string, pathname: string, req: Request): Promise<Response> {
  const headers: Record<string, string> = {
    ...cacheHeaders(pathname),
    Vary: "Accept-Encoding",
  };
  // Set the type from the original path — a compressed sibling must still
  // report e.g. application/wasm, not the encoding's type.
  const type = CONTENT_TYPES[extname(pathname)];
  if (type) headers["Content-Type"] = type;

  // Serve a build-time pre-compressed sibling when the client accepts it.
  const accept = req.headers.get("accept-encoding") ?? "";
  for (const [token, ext] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (!accept.includes(token)) continue;
    const encoded = Bun.file(filePath + ext);
    if (await encoded.exists()) {
      headers["Content-Encoding"] = token;
      return new Response(encoded, { headers });
    }
  }
  return new Response(Bun.file(filePath), { headers });
}

/**
 * Cache policy. Without this the browser re-downloads the ~21MB of ONNX models
 * and the ORT wasm runtime under /models/ on every load, which is why VAD takes
 * a long time to go active. /assets/ is content-hashed by Vite (safe forever);
 * /models/ is large and effectively immutable between deploys, so cache it hard
 * too; the HTML shell must always revalidate.
 */
function cacheHeaders(pathname: string): Record<string, string> {
  if (pathname.startsWith("/assets/")) {
    return { "Cache-Control": "public, max-age=31536000, immutable" };
  }
  if (pathname.startsWith("/models/")) {
    return { "Cache-Control": "public, max-age=2592000, immutable" };
  }
  if (pathname.endsWith(".html")) {
    return { "Cache-Control": "no-cache" };
  }
  return {};
}
