import { parsePutBody, parseSubscription, testPayload, type SubscriptionRecord } from './alerts'
import { runAlerts, subKey, vapid, type Env } from './run'
import { sendPush } from './webpush'
// Module form of the Workers types, so the DOM lib (which the app's forecast code is written against) stays in charge of fetch/Response.
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types'

const TEST_COOLDOWN_MS = 20_000

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  return allowed.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
    : { Vary: 'Origin' }
}

const json = (data: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } })

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return null
  }
}

async function handle(req: Request, env: Env): Promise<Response> {
  const h = cors(req, env)
  const { pathname } = new URL(req.url)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h })

  if (req.method === 'GET' && pathname === '/vapid-public-key') return json({ publicKey: env.VAPID_PUBLIC_KEY }, 200, h)

  if (pathname === '/subscription' && req.method === 'PUT') {
    const parsed = parsePutBody(await readJson(req))
    if (typeof parsed === 'string') return json({ error: parsed }, 400, h)
    const key = await subKey(parsed.subscription.endpoint)
    const prev = await env.SUBS.get<SubscriptionRecord>(key, 'json')
    const now = Date.now()
    const rec: SubscriptionRecord = { ...parsed, createdAt: prev?.createdAt ?? now, updatedAt: now, lastAlerts: prev?.lastAlerts ?? {} }
    await env.SUBS.put(key, JSON.stringify(rec))
    return json({ ok: true, favorites: rec.favorites.length }, 200, h)
  }

  if (pathname === '/subscription' && req.method === 'DELETE') {
    const sub = parseSubscription((await readJson(req) as { subscription?: unknown } | null)?.subscription)
    if (typeof sub === 'string') return json({ error: sub }, 400, h)
    await env.SUBS.delete(await subKey(sub.endpoint))
    return json({ ok: true }, 200, h)
  }

  // Sends a test notification to an already-registered subscription only.
  if (pathname === '/test' && req.method === 'POST') {
    const sub = parseSubscription((await readJson(req) as { subscription?: unknown } | null)?.subscription)
    if (typeof sub === 'string') return json({ error: sub }, 400, h)
    const key = await subKey(sub.endpoint)
    const rec = await env.SUBS.get<SubscriptionRecord & { lastTestAt?: number }>(key, 'json')
    if (!rec) return json({ error: 'not subscribed' }, 404, h)
    if (rec.lastTestAt && Date.now() - rec.lastTestAt < TEST_COOLDOWN_MS) return json({ error: 'wait a few seconds between tests' }, 429, h)
    const res = await sendPush(rec.subscription, testPayload(), vapid(env), { urgency: 'high', ttl: 600 })
    if (res.gone) await env.SUBS.delete(key)
    else await env.SUBS.put(key, JSON.stringify({ ...rec, lastTestAt: Date.now() }))
    return json({ ok: res.status < 300, pushStatus: res.status }, res.status < 300 ? 200 : 502, h)
  }

  if (req.method === 'GET' && pathname === '/') return json({ ok: true, service: 'snowcast-alerts' }, 200, h)
  return json({ error: 'not found' }, 404, h)
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env)
    } catch (e) {
      console.error(e)
      return json({ error: 'internal error' }, 500, cors(req, env))
    }
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runAlerts(env))
  },
}
