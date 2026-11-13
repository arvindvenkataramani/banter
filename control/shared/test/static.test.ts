import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveStatic } from "../src/static";

describe("serveStatic cross-origin isolation", () => {
  let dist: string;
  beforeAll(() => {
    dist = mkdtempSync(join(tmpdir(), "static-test-"));
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    writeFileSync(join(dist, "app.js"), "export {}");
    writeFileSync(join(dist, "app.js.br"), "compressed");
  });
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  const cases: [string, string, Record<string, string>?][] = [
    ["the HTML shell", "/"],
    ["a file", "/app.js"],
    ["a pre-compressed sibling", "/app.js", { "accept-encoding": "br" }],
    ["the SPA fallback", "/services/some-id"],
  ];
  for (const [what, path, headers] of cases) {
    it(`isolates ${what}`, async () => {
      const res = await serveStatic(dist, new Request(`https://node.example${path}`, { headers }));
      expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(res.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    });
  }
});
