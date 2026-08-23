// Persistent device identity for gateway authentication.
// Generates an Ed25519 keypair, stores it in localStorage,
// and signs connect.challenge nonces for device-based auth.

const STORAGE_KEY = 'openclaw-device-keypair'

interface StoredKeypair {
  publicKey: string   // base64 SPKI DER
  privateKey: string  // base64 PKCS8 DER
}

// Ed25519 SPKI prefix: 12 bytes before the 32-byte raw key
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
])

let cachedKeyPair: CryptoKeyPair | null = null
let cachedRawPublicKey: Uint8Array | null = null
let cachedDeviceId: string | null = null

function b64Encode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf
}

function b64url(buf: ArrayBuffer): string {
  return b64Encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function rawEd25519FromSpki(spki: Uint8Array): Uint8Array {
  const prefix = ED25519_SPKI_PREFIX
  if (spki.length !== prefix.length + 32) throw new Error('unexpected SPKI length')
  for (let i = 0; i < prefix.length; i++) {
    if (spki[i] !== prefix[i]) throw new Error('unexpected SPKI prefix')
  }
  // slice() to get a new ArrayBuffer — subarray() shares the parent buffer
  return new Uint8Array(spki.buffer.slice(prefix.length))
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function getOrCreateKeyPair(): Promise<CryptoKeyPair> {
  if (cachedKeyPair) return cachedKeyPair

  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      const kp: StoredKeypair = JSON.parse(stored)
      const privateKey = await crypto.subtle.importKey(
        'pkcs8', b64Decode(kp.privateKey).buffer as ArrayBuffer,
        { name: 'Ed25519' },
        false, ['sign'],
      )
      const publicKey = await crypto.subtle.importKey(
        'spki', b64Decode(kp.publicKey).buffer as ArrayBuffer,
        { name: 'Ed25519' },
        true, ['verify'],
      )
      cachedKeyPair = { privateKey, publicKey }
      return cachedKeyPair
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true, ['sign', 'verify'],
  )
  const spkiDer = await crypto.subtle.exportKey('spki', keyPair.publicKey)
  const pkcs8Der = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    publicKey: b64Encode(spkiDer),
    privateKey: b64Encode(pkcs8Der),
  }))
  cachedKeyPair = keyPair
  return keyPair
}

async function getRawPublicKey(): Promise<Uint8Array> {
  if (cachedRawPublicKey) return cachedRawPublicKey
  const { publicKey } = await getOrCreateKeyPair()
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey))
  cachedRawPublicKey = rawEd25519FromSpki(spki)
  return cachedRawPublicKey
}

async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId
  const raw = await getRawPublicKey()
  cachedDeviceId = await sha256Hex(raw)
  return cachedDeviceId
}

// Short handle for display: two tabs of the same browser are identical in
// every other respect, and this matches the row in `openclaw devices list`.
export async function getDeviceIdPrefix(): Promise<string> {
  return (await getDeviceId()).slice(0, 6)
}

export interface DeviceAuth {
  id: string
  publicKey: string
  signature: string
  signedAt: number
  nonce: string
}

export async function signChallenge(
  nonce: string,
  token: string,
  clientId: string,
  clientMode: string,
  role: string,
  scopes: string[],
): Promise<DeviceAuth> {
  const { privateKey } = await getOrCreateKeyPair()
  const rawPub = await getRawPublicKey()
  const deviceId = await getDeviceId()
  const signedAt = Date.now()
  const platform = 'web'
  const deviceFamily = 'browser'

  // v3 signed payload format
  const payload = [
    'v3',
    deviceId,
    clientId,
    clientMode,
    role,
    scopes.join(','),
    String(signedAt),
    token,
    nonce,
    platform,
    deviceFamily,
  ].join('|')

  const data = new TextEncoder().encode(payload)
  const sig = await crypto.subtle.sign('Ed25519', privateKey, data)

  return {
    id: deviceId,
    publicKey: b64url(rawPub.buffer as ArrayBuffer),
    signature: b64url(sig),
    signedAt,
    nonce,
  }
}
