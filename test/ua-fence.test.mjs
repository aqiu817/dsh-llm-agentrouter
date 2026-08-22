/**
 * Behavioural tests for the relay fence, run with `node --test`.
 *
 * They exercise the wrapper against a local HTTP server rather than the relay:
 * what needs proving is that the right header and the right origin reach the
 * wire for the right host, that unrelated hosts are untouched, that an endpoint
 * switch is observed without reinstalling anything, and that unloading restores
 * the fetch that was replaced. Reaching the relay proves none of those.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const FENCE_UA = 'claude-cli/2.1.161 (external, cli)'
const HARNESS_UA = 'deepseek-harness/0.1.1 (+https://github.com/deepseek-ai/deepseek-harness)'
const SENTINEL = 'relay.agentrouter.internal'

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
      seen.push({
        ua: req.headers['user-agent'],
        auth: req.headers.authorization,
        host: req.headers.host,
        method: req.method,
        path: req.url,
        body,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${server.address().port}`
})

after(() => new Promise((resolve) => server.close(resolve)))

/**
 * Activate the plugin with a stub Cordis context and a stub settings service.
 *
 * The stub settings plane is what makes the endpoint observable: it hands the
 * plugin a scope whose `get()` reads a mutable section, exactly as the real
 * service does, so a test can switch endpoints the way the settings card does.
 *
 * @param {object} overrides - fields overriding the schema defaults.
 * @returns {{dispose: () => void, section: (patch: object) => void}} the handle.
 */
async function activate(overrides) {
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config(overrides)
  let resolved = entry
  const disposers = []
  const ctx = {
    effect(fn) {
      disposers.push(fn() ?? (() => {}))
    },
    /** The real plugin reaches the settings service through `ctx.inject`. */
    inject(_services, callback) {
      callback({
        settings: {
          register: () => ({ get: () => resolved, watch: () => () => {} }),
        },
        effect(fn) {
          disposers.push(fn() ?? (() => {}))
        },
      })
    },
    fiber: { state: 2 },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, entry)
  return {
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
    /** Replace the resolved section, as a settings write does. */
    section: (patch) => {
      resolved = Config({ ...overrides, ...patch })
    },
  }
}

test('rewrites the sentinel host to the selected endpoint and sends the relay User-Agent', async () => {
  const fence = await activate({
    endpoint: 'cn',
    endpoints: { cn: host, intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
  })
  try {
    const res = await fetch(`http://${SENTINEL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'user-agent': HARNESS_UA, authorization: 'Bearer test-key', 'content-type': 'application/json' },
      body: '{"model":"claude-opus-5"}',
    })
    assert.equal(res.status, 200)
    await res.json()
  } finally {
    fence.dispose()
  }
  const last = seen.at(-1)
  assert.equal(last.ua, FENCE_UA, 'the relay User-Agent must reach the wire')
  assert.equal(last.host, host, 'the request must reach the selected endpoint')
  assert.equal(last.path, '/v1/chat/completions', 'the path survives re-addressing')
  assert.equal(last.auth, 'Bearer test-key', 'every other header survives untouched')
  assert.equal(last.body, '{"model":"claude-opus-5"}', 'the body is never rebuilt')
})

test('an endpoint switch is observed without reinstalling the fence', async () => {
  const fence = await activate({
    endpoint: 'intl',
    endpoints: { cn: host, intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
  })
  try {
    // The international endpoint does not resolve, which is what a wrong choice
    // looks like from here; switching sections must be enough to fix it.
    await assert.rejects(fetch(`http://${SENTINEL}/v1/models`), 'the unselected endpoint must not be used')
    fence.section({ endpoint: 'cn' })
    const res = await fetch(`http://${SENTINEL}/v1/models`, { headers: { 'user-agent': HARNESS_UA } })
    assert.equal(res.status, 200)
    await res.json()
  } finally {
    fence.dispose()
  }
  assert.equal(seen.at(-1).host, host, 'the next request follows the new endpoint')
  assert.equal(seen.at(-1).ua, FENCE_UA)
})

test('a request already addressed to an endpoint keeps its origin and gains the User-Agent', async () => {
  const fence = await activate({
    endpoint: 'cn',
    endpoints: { cn: host, intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
  })
  try {
    const res = await fetch(`http://${host}/v1/models`, { headers: { 'user-agent': HARNESS_UA } })
    await res.json()
  } finally {
    fence.dispose()
  }
  assert.equal(seen.at(-1).host, host, 'a real endpoint is never re-addressed')
  assert.equal(seen.at(-1).ua, FENCE_UA)
})

test('leaves an unrelated host alone', async () => {
  const fence = await activate({
    endpoint: 'cn',
    endpoints: { cn: 'relay.invalid', intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
  })
  try {
    const res = await fetch(`http://${host}/`, { headers: { 'user-agent': HARNESS_UA } })
    await res.text()
  } finally {
    fence.dispose()
  }
  assert.equal(seen.at(-1).ua, HARNESS_UA, 'attribution must survive for every other host')
})

test('a bare Request is re-addressed without losing its body or method', async () => {
  const fence = await activate({
    endpoint: 'cn',
    endpoints: { cn: host, intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
  })
  try {
    const request = new Request(`http://${SENTINEL}/v1/messages`, {
      method: 'POST',
      headers: { 'user-agent': HARNESS_UA },
      body: '{"probe":1}',
    })
    const res = await fetch(request)
    await res.text()
  } finally {
    fence.dispose()
  }
  const last = seen.at(-1)
  assert.equal(last.ua, FENCE_UA)
  assert.equal(last.host, host)
  assert.equal(last.method, 'POST')
  assert.equal(last.body, '{"probe":1}')
})

test('disposal restores the previous fetch', async () => {
  const before_ = globalThis.fetch
  const fence = await activate({ announce: false })
  assert.notEqual(globalThis.fetch, before_, 'activation installs the fence')
  fence.dispose()
  assert.equal(globalThis.fetch, before_, 'unloading must restore the fetch it replaced')
})
