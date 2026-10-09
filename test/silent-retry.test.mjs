/**
 * Behavioural tests for the silent-retry switch, run with `node --test`.
 *
 * The relay round-robins one model id across upstream channels that disagree
 * about how replayed reasoning must be encoded, so the same request is accepted
 * or rejected depending on which channel drew it. The harness treats the
 * rejection as terminal — `INVALID_REQUEST` is not in its default retryable set
 * — so the fence, which already holds the serialized bytes, is where a re-send
 * can happen. These tests pin the four properties that matter: off by default,
 * a channel-dialect rejection absorbed, a genuine 400 surfaced untouched, and a
 * bounded attempt count.
 *
 * A local server stands in for the relay: what needs proving is which responses
 * are re-sent and what the caller finally sees, not that the relay is reachable.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const SENTINEL = 'relay.agentrouter.internal'
/** The wording the relay uses when a channel rejects a replayed assistant turn. */
const DIALECT_REJECTION =
  'The `content[].thinking` in the thinking mode must be passed back to the API. (request_id: t)'

/** Bodies the stub server saw, in order. */
let received = []
/** Per-test response script: status plus body for each successive request. */
let script = []
let server
let host

before(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      received.push(body)
      const step = script[Math.min(received.length - 1, script.length - 1)] ?? { status: 200, body: '{"ok":true}' }
      const headers = { 'content-type': step.type ?? 'application/json' }
      // A truncated body: the declared length exceeds what the socket delivers,
      // so the body read fails after the status and headers have already
      // arrived. Used to pin what the fence does when it cannot read a response
      // it has to inspect. The socket is destroyed on a later tick, because
      // destroying it in this one tears the response down before the caller has
      // its headers, and the failure would then be undici's rather than the
      // fence's — which is what this test must not accidentally measure.
      if (step.truncated === true) {
        headers['content-length'] = String(Buffer.byteLength(step.body) + 64)
        res.writeHead(step.status, headers)
        res.write(step.body)
        setTimeout(() => res.socket?.destroy(), 10)
        return
      }
      res.writeHead(step.status, headers)
      res.end(step.body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${server.address().port}`
})

after(() => new Promise((resolve) => server.close(resolve)))

/**
 * Activate the plugin with a stub Cordis context.
 *
 * @param {object} overrides - fields overriding the schema defaults.
 * @returns {{dispose: () => void}} the handle.
 */
async function activate(overrides) {
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config({
    endpoint: 'cn',
    endpoints: { cn: host, intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
    // The native path: these tests spec retry semantics, not the transport.
    directEndpoints: 'none',
    ...overrides,
  })
  const disposers = []
  apply(
    {
      effect(fn) {
        disposers.push(fn() ?? (() => {}))
      },
      fiber: { state: 2 },
      logger: { info() {}, warn() {} },
    },
    entry,
  )
  return { dispose: () => disposers.reverse().forEach((dispose) => dispose()) }
}

/** One relay-shaped call through the fence. */
function callRelay(body = '{"model":"deepseek-v4-flash"}') {
  return fetch(`http://${SENTINEL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-key' },
    body,
  })
}

test('silent retry is off by default, so a rejection reaches the caller', async () => {
  received = []
  script = [{ status: 400, body: JSON.stringify({ error: { message: DIALECT_REJECTION } }) }]
  const fence = await activate({})
  try {
    const res = await callRelay()
    assert.equal(res.status, 400, 'the relay status must reach the caller')
    assert.equal(received.length, 1, 'nothing may be re-sent while the switch is off')
  } finally {
    fence.dispose()
  }
})

test('a channel-dialect rejection is re-sent until a channel accepts it', async () => {
  received = []
  script = [
    { status: 400, body: JSON.stringify({ error: { message: DIALECT_REJECTION } }) },
    { status: 200, body: '{"ok":true,"served":2}' },
  ]
  const fence = await activate({ silentRetry: true, silentRetryAttempts: 3 })
  try {
    const res = await callRelay('{"model":"deepseek-v4-flash","messages":[]}')
    assert.equal(res.status, 200, 'the caller must see the successful attempt')
    assert.deepEqual(await res.json(), { ok: true, served: 2 })
    assert.equal(received.length, 2, 'exactly one re-send was needed')
    assert.equal(received[0], received[1], 'every attempt must put identical bytes on the wire')
  } finally {
    fence.dispose()
  }
})

test('a genuine 400 is surfaced without being re-sent', async () => {
  received = []
  script = [{ status: 400, body: JSON.stringify({ error: { message: 'unknown model: no-such-model' } }) }]
  const fence = await activate({ silentRetry: true, silentRetryAttempts: 3 })
  try {
    const res = await callRelay()
    assert.equal(res.status, 400, 'an unrelated bad request must not be masked')
    assert.match(await res.text(), /unknown model/)
    assert.equal(received.length, 1, 'only a known transient wording is worth re-sending')
  } finally {
    fence.dispose()
  }
})

test('a 5xx is re-sent without reading its body first', async () => {
  received = []
  script = [
    { status: 503, body: 'Service temporarily unavailable' },
    { status: 200, body: '{"ok":true}' },
  ]
  const fence = await activate({ silentRetry: true, silentRetryAttempts: 3 })
  try {
    const res = await callRelay()
    assert.equal(res.status, 200)
    assert.equal(received.length, 2)
  } finally {
    fence.dispose()
  }
})

test('the attempt count bounds how many times a request is re-sent', async () => {
  received = []
  script = [{ status: 503, body: 'Service temporarily unavailable' }]
  const fence = await activate({ silentRetry: true, silentRetryAttempts: 4 })
  try {
    const res = await callRelay()
    assert.equal(res.status, 503, 'a persistently broken route still reports an error')
    assert.equal(received.length, 4, 'the ceiling is a total attempt count, the first included')
  } finally {
    fence.dispose()
  }
})

test('a settings write turns the switch on without reinstalling the fence', async () => {
  received = []
  script = [
    { status: 400, body: JSON.stringify({ error: { message: DIALECT_REJECTION } }) },
    { status: 200, body: '{"ok":true}' },
  ]
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config({
    endpoint: 'cn',
    endpoints: { cn: host, intl: 'unreachable.invalid' },
    sentinel: SENTINEL,
    announce: false,
    directEndpoints: 'none',
    silentRetry: false,
  })
  const disposers = []
  apply(
    {
      effect(fn) {
        disposers.push(fn() ?? (() => {}))
      },
      fiber: { state: 2 },
      logger: { info() {}, warn() {} },
    },
    entry,
  )
  try {
    // The volatile field arrives as a frozen reference cell whose writer is
    // private. A settings write commits a freshly validated cell into it via
    // cosmokit's `updateVolatile`; the cell is mutated in place rather than the
    // fiber reloading, so the fence must observe the new value on the next call.
    const cell = entry.silentRetry
    assert.equal(typeof cell?.get, 'function', 'silentRetry must be a volatile reference cell')
    assert.equal(cell.get(), false, 'the switch starts off')
    const { updateVolatile } = await import('@deepseek-ai/cosmokit')
    updateVolatile(cell, Config({ silentRetry: true }).silentRetry)
    assert.equal(cell.get(), true)
    const res = await callRelay()
    assert.equal(res.status, 200, 'the switch takes effect on the next request')
    assert.equal(received.length, 2)
  } finally {
    disposers.reverse().forEach((dispose) => dispose())
  }
})

test('a 400 whose body cannot be read is surfaced, not turned into an exception', async () => {
  // The switch exists to hide the relay's channel flapping, never a broken
  // connection: re-sending cannot help a body this side never received, and
  // swallowing the status would replace a diagnosable 400 with an opaque
  // transport error. With the switch on the outcome must match the switch off.
  received = []
  script = [{ status: 400, body: `{"error":{"message":"${DIALECT_REJECTION}"`, truncated: true }]
  const fence = await activate({ silentRetry: true, silentRetryAttempts: 3 })
  try {
    const res = await callRelay()
    assert.equal(res.status, 400, 'the relay status must survive an unreadable body')
  } finally {
    fence.dispose()
  }
  assert.equal(received.length, 1, 'an unreadable body must not be re-sent')
})
