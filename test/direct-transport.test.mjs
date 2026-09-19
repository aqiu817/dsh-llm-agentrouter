/**
 * Behavioural tests for the fence's direct transport, run with `node --test`.
 *
 * The relay's WAF answers datacenter egress — the exit an HTTPS_PROXY hop
 * produces — with a 200 HTML interstitial instead of the stream, so the fence
 * owns a direct `node:http` transport for covered endpoints. What needs
 * proving: the bridge itself speaks HTTP faithfully (method, headers, body,
 * streaming response, abort), the fence reaches for it only when a proxy is
 * actually configured and the destination endpoint is covered by the bypass,
 * and the native path survives untouched otherwise.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const FENCE_UA = 'claude-cli/2.1.161 (external, cli)'
const SENTINEL = 'relay.agentrouter.internal'

/** Proxy variables the fence keys its bypass on; saved and restored per test. */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']

function setProxyEnv(value) {
  for (const name of PROXY_VARS) process.env[name] = value
}
function clearProxyEnv() {
  for (const name of PROXY_VARS) delete process.env[name]
}

/** Requests the echo server saw, most recent last. */
const seen = []
let host = ''
let server

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      seen.push({ ua: req.headers['user-agent'], host: req.headers.host, method: req.method, path: req.url, body })
      if (req.url === '/streamed') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: one\n\n')
        setTimeout(() => {
          res.write('data: two\n\n')
          res.end('data: [DONE]\n\n')
        }, 30)
        return
      }
      if (req.url === '/no-content') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.url === '/hanging') return // never answers; the client must be the one to hang up
      if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: one\n\n')
        return // more data never comes; the client decides when to stop
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${server.address().port}`
})

after(() => {
  clearProxyEnv()
  return new Promise((resolve) => server.close(resolve))
})

test('directFetch speaks plain HTTP: method, headers, string body, and the response', async () => {
  const { directFetch } = await import('../lib/direct-fetch.js')
  const res = await directFetch(`http://${host}/v1/chat/completions`, {
    method: 'POST',
    headers: new Headers({ 'user-agent': FENCE_UA, 'content-type': 'application/json' }),
    body: '{"probe":"bridge"}',
  })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.deepEqual(await res.json(), { ok: true })

  const last = seen.at(-1)
  assert.equal(last.ua, FENCE_UA)
  assert.equal(last.method, 'POST')
  assert.equal(last.path, '/v1/chat/completions')
  assert.equal(last.body, '{"probe":"bridge"}')
})

test('directFetch streams the response body chunk by chunk', async () => {
  const { directFetch } = await import('../lib/direct-fetch.js')
  const res = await directFetch(`http://${host}/streamed`)
  const reader = res.body.getReader()
  const first = new TextDecoder().decode((await reader.read()).value)
  assert.match(first, /data: one/, 'the first chunk arrives before the stream ends')
  const rest = first + new TextDecoder().decode((await reader.read()).value)
  assert.match(rest, /data: two/)
})

test('directFetch maps 204 to a body-less response', async () => {
  const { directFetch } = await import('../lib/direct-fetch.js')
  const res = await directFetch(`http://${host}/no-content`)
  assert.equal(res.status, 204)
  assert.equal(res.body, null)
})

test('directFetch rejects with an AbortError when the signal fires mid-flight', async () => {
  const { directFetch } = await import('../lib/direct-fetch.js')
  const controller = new AbortController()
  // A route that never answers: the abort always lands while the request is
  // still in flight.
  const pending = directFetch(`http://${host}/hanging`, { signal: controller.signal })
  const abort = setTimeout(() => controller.abort(), 20)
  await assert.rejects(pending, (err) => err.name === 'AbortError')
  clearTimeout(abort)
})

test('directFetch cuts a streaming body when aborted after the headers', async () => {
  const { directFetch } = await import('../lib/direct-fetch.js')
  const controller = new AbortController()
  const res = await directFetch(`http://${host}/slow`, { signal: controller.signal })
  assert.equal(res.status, 200)
  const reader = res.body.getReader()
  await reader.read()
  controller.abort()
  await assert.rejects(reader.read(), 'the body stream must die with the signal')
})

test('directFetch rejects connections it cannot make', async () => {
  const { directFetch } = await import('../lib/direct-fetch.js')
  await assert.rejects(directFetch('http://127.0.0.1:1/'), (err) => err instanceof TypeError)
})

test('the fence sends covered endpoints direct when a proxy is configured', async () => {
  setProxyEnv('http://127.0.0.1:9')
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config({
    endpoint: 'cn',
    endpoints: { cn: host, intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
  })
  const previous = globalThis.fetch
  // A native fetch that must never be reached while the bridge is in charge.
  globalThis.fetch = () => {
    throw new Error('native fetch must not be used for a covered endpoint')
  }
  const disposers = []
  apply(
    {
      effect: (fn) => disposers.push(fn() ?? (() => {})),
      inject: () => {},
      logger: { info() {}, warn() {} },
    },
    entry,
  )
  try {
    const res = await fetch(`http://${SENTINEL}/v1/models`, { headers: { 'user-agent': 'harness' } })
    assert.equal(res.status, 200, 'the request reached the endpoint over the direct transport')
    await res.json()
    // A request already addressed to the covered endpoint takes the same path.
    const res2 = await fetch(`http://${host}/v1/models`, { headers: { 'user-agent': 'harness' } })
    assert.equal(res2.status, 200)
    await res2.json()
    assert.equal(seen.at(-1).ua, FENCE_UA, 'the relay User-Agent rides the direct transport too')
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    globalThis.fetch = previous
  }
})

test('the fence keeps the proxy path for endpoints the bypass does not cover', async () => {
  setProxyEnv('http://127.0.0.1:9')
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config({
    endpoint: 'intl',
    endpoints: { cn: 'unreachable.invalid', intl: host },
    sentinel: SENTINEL,
    announce: false,
  })
  const previous = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('native fetch must be used for an uncovered endpoint'))
  const disposers = []
  apply(
    {
      effect: (fn) => disposers.push(fn() ?? (() => {})),
      inject: () => {},
      logger: { info() {}, warn() {} },
    },
    entry,
  )
  try {
    await assert.rejects(
      () => fetch(`http://${SENTINEL}/v1/models`, { headers: { 'user-agent': 'harness' } }),
      /native fetch must be used/,
      'the international endpoint keeps the process transport',
    )
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    globalThis.fetch = previous
  }
})

test('the direct transport is a no-op without proxy variables in the environment', async () => {
  clearProxyEnv()
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config({
    endpoint: 'cn',
    endpoints: { cn: 'unreachable.invalid', intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
  })
  const previous = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('native fetch must be used when no proxy is configured'))
  const disposers = []
  apply(
    {
      effect: (fn) => disposers.push(fn() ?? (() => {})),
      inject: () => {},
      logger: { info() {}, warn() {} },
    },
    entry,
  )
  try {
    await assert.rejects(
      () => fetch(`http://${SENTINEL}/v1/models`, { headers: { 'user-agent': 'harness' } }),
      /native fetch must be used/,
      'without a proxy to escape, the native path stays',
    )
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    globalThis.fetch = previous
  }
})

test('directEndpoints none keeps every endpoint on the process transport', async () => {
  setProxyEnv('http://127.0.0.1:9')
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config({
    endpoint: 'cn',
    endpoints: { cn: 'unreachable.invalid', intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    directEndpoints: 'none',
    announce: false,
  })
  const previous = globalThis.fetch
  globalThis.fetch = () => Promise.reject(new Error('native fetch must be used when the bypass is off'))
  const disposers = []
  apply(
    {
      effect: (fn) => disposers.push(fn() ?? (() => {})),
      inject: () => {},
      logger: { info() {}, warn() {} },
    },
    entry,
  )
  try {
    await assert.rejects(
      () => fetch(`http://${SENTINEL}/v1/models`, { headers: { 'user-agent': 'harness' } }),
      /native fetch must be used/,
    )
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    globalThis.fetch = previous
  }
})
