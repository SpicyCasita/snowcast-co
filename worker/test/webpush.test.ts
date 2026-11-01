import { describe, expect, it } from 'vitest'
import { b64urlDecode, b64urlEncode, concat, encryptPayload, vapidAuthorization, type PushSubscriptionJSON } from '../src/webpush'

const enc = new TextEncoder()

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8))
}

/** A browser-side subscription with its private key, so the test can decrypt like a push service client would. */
async function fakeBrowser() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey) as ArrayBuffer)
  const auth = crypto.getRandomValues(new Uint8Array(16))
  const sub: PushSubscriptionJSON = { endpoint: 'https://push.example.com/send/xyz', keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) } }
  return { sub, keys, pub, auth }
}

/** RFC 8291 receiver side. */
async function decrypt(body: Uint8Array, ua: Awaited<ReturnType<typeof fakeBrowser>>): Promise<string> {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16)
  const idlen = body[20]
  const asPublic = body.slice(21, 21 + idlen)
  const ciphertext = body.slice(21 + idlen)
  expect(rs).toBe(4096)
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.keys.privateKey, 256))
  const ikm = await hkdf(ua.auth, secret, concat(enc.encode('WebPush: info\0'), ua.pub, asPublic), 32)
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext))
  expect(plain[plain.length - 1]).toBe(2)
  return new TextDecoder().decode(plain.slice(0, -1))
}

describe('encryptPayload', () => {
  it('round-trips through an RFC 8291 decryptor', async () => {
    const ua = await fakeBrowser()
    const message = JSON.stringify({ title: '❄ Vail: 8" of snow forecast', body: 'test' })
    const body = await encryptPayload(enc.encode(message), ua.sub)
    expect(await decrypt(body, ua)).toBe(message)
  })

  it('uses a fresh salt and server key each time', async () => {
    const ua = await fakeBrowser()
    const a = await encryptPayload(enc.encode('x'), ua.sub)
    const b = await encryptPayload(enc.encode('x'), ua.sub)
    expect(b64urlEncode(a.slice(0, 86))).not.toBe(b64urlEncode(b.slice(0, 86)))
  })
})

describe('vapidAuthorization', () => {
  it('signs an ES256 JWT for the endpoint origin', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
    const publicKey = b64urlEncode(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer)
    const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const header = await vapidAuthorization('https://web.push.apple.com/abc/def', { publicKey, privateKey: d!, subject: 'https://example.com/' }, 1_000_000)

    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!
    expect(m).not.toBeNull()
    expect(m[4]).toBe(publicKey)
    const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(m[2])))
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: 1_000_000 + 12 * 3600, sub: 'https://example.com/' })
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, b64urlDecode(m[3]), enc.encode(`${m[1]}.${m[2]}`))
    expect(ok).toBe(true)
  })
})

describe('base64url', () => {
  it('round-trips without padding', () => {
    const bytes = new Uint8Array([251, 255, 0, 1, 2])
    expect(b64urlEncode(bytes)).toBe('-_8AAQI')
    expect([...b64urlDecode('-_8AAQI')]).toEqual([...bytes])
  })
})
