import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { loadOrCreateIdentity, signChallenge } from "../probe/identity";

let dir: string;
let identityPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "probe-identity-"));
  identityPath = join(dir, "identity.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("probe identity", () => {
  it("creates an identity file on first load and returns the same device id on reload", () => {
    const first = loadOrCreateIdentity(identityPath);
    const second = loadOrCreateIdentity(identityPath);
    expect(first.deviceId).toBe(second.deviceId);
    expect(first.deviceId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes the identity file readable only by the owner", () => {
    loadOrCreateIdentity(identityPath);
    const mode = statSync(identityPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("derives the device id as the sha256 of the raw public key", () => {
    const identity = loadOrCreateIdentity(identityPath);
    const raw = Buffer.from(identity.publicKeyRawB64Url, "base64url");
    expect(raw.length).toBe(32);
    const expected = createHash("sha256").update(raw).digest("hex");
    expect(identity.deviceId).toBe(expected);
  });

  it("signs a v3 challenge payload verifiable with the stored public key", () => {
    const identity = loadOrCreateIdentity(identityPath);
    const auth = signChallenge(identity, {
      nonce: "nonce-123",
      token: "token-abc",
      clientId: "openclaw-probe",
      clientMode: "probe",
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      platform: "linux",
      deviceFamily: "server",
    });

    expect(auth.id).toBe(identity.deviceId);
    expect(auth.nonce).toBe("nonce-123");
    expect(typeof auth.signedAt).toBe("number");

    const payload = [
      "v3",
      identity.deviceId,
      "openclaw-probe",
      "probe",
      "operator",
      "operator.read,operator.write",
      String(auth.signedAt),
      "token-abc",
      "nonce-123",
      "linux",
      "server",
    ].join("|");

    // Rebuild an SPKI key from the raw public key to verify the signature.
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const spki = Buffer.concat([spkiPrefix, Buffer.from(auth.publicKey, "base64url")]);
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    const ok = cryptoVerify(
      null,
      Buffer.from(payload),
      publicKey,
      Buffer.from(auth.signature, "base64url"),
    );
    expect(ok).toBe(true);
  });
});
