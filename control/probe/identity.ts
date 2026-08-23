// Ed25519 device identity for the gateway probe.
//
// The probe pairs as its own device. It must never read the CLI identity at
// ~/.openclaw/identity/ — a borrowed credential makes a protocol anomaly
// indistinguishable from a bug in whichever client lent it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";

export interface ProbeIdentity {
  deviceId: string;
  publicKeyRawB64Url: string;
  privateKeyPkcs8B64: string;
}

interface StoredIdentity {
  publicKey: string;
  privateKey: string;
}

// Ed25519 SPKI is a fixed 12-byte prefix followed by the 32-byte raw key.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawFromSpki(spki: Buffer): Buffer {
  if (spki.length !== ED25519_SPKI_PREFIX.length + 32) {
    throw new Error("unexpected SPKI length for Ed25519 public key");
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length);
}

export function loadOrCreateIdentity(path: string): ProbeIdentity {
  if (existsSync(path)) {
    const stored: StoredIdentity = JSON.parse(readFileSync(path, "utf8"));
    return derive(stored);
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const stored: StoredIdentity = {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  // writeFileSync honours mode only when creating; set it explicitly so a
  // pre-existing looser file cannot keep its permissions.
  chmodSync(path, 0o600);

  return derive(stored);
}

function derive(stored: StoredIdentity): ProbeIdentity {
  const spki = Buffer.from(stored.publicKey, "base64");
  const raw = rawFromSpki(spki);
  return {
    deviceId: createHash("sha256").update(raw).digest("hex"),
    publicKeyRawB64Url: raw.toString("base64url"),
    privateKeyPkcs8B64: stored.privateKey,
  };
}

export interface DeviceAuth {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
}

export interface ChallengeParams {
  nonce: string;
  token: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  platform: string;
  deviceFamily: string;
}

export function signChallenge(identity: ProbeIdentity, params: ChallengeParams): DeviceAuth {
  const signedAt = Date.now();

  // v3 signed payload: field order is part of the protocol contract.
  const payload = [
    "v3",
    identity.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(signedAt),
    params.token,
    params.nonce,
    params.platform,
    params.deviceFamily,
  ].join("|");

  const privateKey = createPrivateKey({
    key: Buffer.from(identity.privateKeyPkcs8B64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = cryptoSign(null, Buffer.from(payload), privateKey);

  return {
    id: identity.deviceId,
    publicKey: identity.publicKeyRawB64Url,
    signature: signature.toString("base64url"),
    signedAt,
    nonce: params.nonce,
  };
}

/** Public key in the form `openclaw devices` displays, for pairing checks. */
export function publicKeyFingerprint(identity: ProbeIdentity): string {
  const spki = Buffer.concat([
    ED25519_SPKI_PREFIX,
    Buffer.from(identity.publicKeyRawB64Url, "base64url"),
  ]);
  createPublicKey({ key: spki, format: "der", type: "spki" });
  return identity.deviceId.slice(0, 12);
}
