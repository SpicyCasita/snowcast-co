// Prints a new VAPID key pair. Run once: `npm run vapid-keys`.
// Changing keys later invalidates every existing subscription (people would have to re-enable alerts).
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
const { d } = await crypto.subtle.exportKey('jwk', privateKey)
const b64url = bytes => Buffer.from(bytes).toString('base64url')

console.log(`VAPID_PUBLIC_KEY  = ${b64url(raw)}`)
console.log(`VAPID_PRIVATE_KEY = ${d}`)
console.log(`
1. Put VAPID_PUBLIC_KEY in wrangler.toml under [vars].
2. Run \`npx wrangler secret put VAPID_PRIVATE_KEY\` and paste the private key when asked.
   Keep it out of git. For \`wrangler dev\`, put VAPID_PRIVATE_KEY=... in worker/.dev.vars (git-ignored).`)
