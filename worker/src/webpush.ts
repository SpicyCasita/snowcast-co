/**
 * Minimal Web Push for Workers: VAPID (RFC 8292) auth and aes128gcm payload encryption (RFC 8291),
 * using only WebCrypto.
 */

export interface PushSubscriptionJSON {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export interface VapidKeys {
  /** Uncompressed P-256 point (65 bytes), base64url. Also what the browser subscribes with. */
  publicKey: string
  /** Private scalar d (32 bytes), base64url. */
  privateKey: string
  /** mailto: or https: contact for the push service. */
  subject: string
}

const enc = new TextEncoder()

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64urlDecode(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

const importPublic = (raw: Uint8Array) =>
  crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, [])

/** Signing key from the base64url public point and private scalar. */
async function vapidSigningKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlDecode(keys.publicKey)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point')
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: keys.privateKey,
    ext: true,
  }
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

/** `Authorization` header value for a push to `endpoint`. */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  // Push services cap exp at 24h; 12h leaves room for clock skew.
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: keys.subject })))
  const unsigned = `${header}.${claims}`
  // WebCrypto ECDSA signatures are already the raw r||s form that JWS ES256 wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(keys), enc.encode(unsigned))
  return `vapid t=${unsigned}.${b64urlEncode(sig)}, k=${keys.publicKey}`
}

/** Encrypt `payload` for one subscription as a single aes128gcm record. */
export async function encryptPayload(
  payload: Uint8Array,
  sub: PushSubscriptionJSON,
  // Injectable for tests; random in production.
  opts: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.keys.p256dh)
  const authSecret = b64urlDecode(sub.keys.auth)
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const server = opts.serverKeys ?? (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair)
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', server.publicKey) as ArrayBuffer)

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(uaPublic) }, server.privateKey, 256),
  )
  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)

  // 0x02 marks the last (and only) record; no extra padding.
  const plaintext = concat(payload, new Uint8Array([2]))
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext))

  const rs = 4096
  const header = new Uint8Array(16 + 4 + 1)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, rs)
  header[20] = asPublic.length
  return concat(header, asPublic, ciphertext)
}

export interface PushResult {
  status: number
  /** The subscription is gone for good and should be deleted. */
  gone: boolean
}

export async function sendPush(
  sub: PushSubscriptionJSON,
  payload: unknown,
  keys: VapidKeys,
  { ttl = 6 * 3600, urgency = 'normal', topic }: { ttl?: number; urgency?: 'low' | 'normal' | 'high'; topic?: string } = {},
): Promise<PushResult> {
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub)
  const headers: Record<string, string> = {
    Authorization: await vapidAuthorization(sub.endpoint, keys),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
  }
  // Topic lets the push service replace an undelivered older alert for the same thing (max 32 url-safe chars).
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body })
  return { status: res.status, gone: res.status === 404 || res.status === 410 }
}
