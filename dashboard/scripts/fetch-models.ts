#!/usr/bin/env bun
// Downloads the browser voice pipeline's pinned model/runtime assets into
// public/models/, verifying each against a pinned SHA-256 before accepting
// it. These assets are committed to the repo, so a fresh clone already has
// them and does not need to run this — it exists to re-verify them against
// their pins, and to re-fetch after a pin or a URL legitimately changes.
//
// For each asset: download to a temp file, hash it, and only rename it into
// place if the hash matches the pin below. A mismatch is never accepted as a
// near-miss — the temp file is discarded and the next candidate URL (if any)
// is tried instead. ORT's own WASM runtime needs no download here; the
// `copyOrtWasm` Vite plugin copies it out of node_modules at build time.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

const MODELS_DIR = join(import.meta.dir, "..", "public", "models");

interface Asset {
  name: string;
  /** Relative to public/models/. */
  path: string;
  sha256: string;
  /** Tried in order; the first whose downloaded content hashes to `sha256` wins. */
  urls: string[];
}

const ASSETS: Asset[] = [
  {
    name: "Silero VAD (legacy opset)",
    path: "silero_vad_legacy.onnx",
    sha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28",
    urls: [
      "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.24/dist/silero_vad_legacy.onnx",
      "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.23/dist/silero_vad_legacy.onnx",
      "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.22/dist/silero_vad_legacy.onnx",
      "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.21/dist/silero_vad_legacy.onnx",
      "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.20/dist/silero_vad_legacy.onnx",
      "https://raw.githubusercontent.com/snakers4/silero-vad/v4.0/files/silero_vad.onnx",
      "https://raw.githubusercontent.com/snakers4/silero-vad/v4.0stable/files/silero_vad.onnx",
    ],
  },
  {
    name: "smart-turn v3.2 CPU",
    path: "smart-turn-v3.2-cpu.onnx",
    sha256: "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
    urls: [
      "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx",
      "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart_turn_v3.2_cpu.onnx",
      "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/model.onnx",
    ],
  },
  {
    name: "whisper-tiny preprocessor config",
    path: "whisper-tiny/preprocessor_config.json",
    sha256: "9b5cd03a36fbb8a627c64d98a5b5b126ead95a77720723944487311f0110b666",
    urls: ["https://huggingface.co/openai/whisper-tiny/resolve/main/preprocessor_config.json"],
  },
];

async function sha256File(path: string): Promise<string> {
  const buf = await Bun.file(path).arrayBuffer();
  return createHash("sha256").update(Buffer.from(buf)).digest("hex");
}

async function tryFetch(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

interface TriedUrl {
  url: string;
  hash: string | null;
}

async function fetchAsset(asset: Asset): Promise<{ ok: boolean; tried: TriedUrl[] }> {
  const destPath = join(MODELS_DIR, asset.path);
  const tempPath = `${destPath}.download`;
  await mkdir(dirname(destPath), { recursive: true });

  const tried: TriedUrl[] = [];

  for (const url of asset.urls) {
    const data = await tryFetch(url);
    if (!data) {
      tried.push({ url, hash: null });
      continue;
    }
    await writeFile(tempPath, data);
    const hash = await sha256File(tempPath);
    if (hash === asset.sha256) {
      await rename(tempPath, destPath);
      console.log(`[fetch-models] ${asset.name}: OK (${url})`);
      return { ok: true, tried };
    }
    tried.push({ url, hash });
    await rm(tempPath, { force: true });
  }

  return { ok: false, tried };
}

async function main() {
  const failures: { asset: Asset; tried: TriedUrl[] }[] = [];

  for (const asset of ASSETS) {
    const result = await fetchAsset(asset);
    if (!result.ok) failures.push({ asset, tried: result.tried });
  }

  if (failures.length > 0) {
    console.error("\n[fetch-models] Could not verify the following assets against their pinned hash:");
    for (const { asset, tried } of failures) {
      console.error(`\n  ${asset.name} (public/models/${asset.path})`);
      console.error(`  expected sha256: ${asset.sha256}`);
      for (const { url, hash } of tried) {
        console.error(`    tried: ${url} -> ${hash ?? "fetch failed"}`);
      }
    }
    console.error(
      "\nNo candidate URL's content matched the pinned hash for the asset(s) above. " +
        "Find a working source and add its URL to the corresponding ASSETS entry in " +
        "this script (or update the pin if the asset legitimately moved), then re-run.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("\n[fetch-models] All assets verified.");
}

await main();
