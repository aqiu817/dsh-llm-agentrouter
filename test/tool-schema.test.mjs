/**
 * Behavioural tests for the tool-schema half of the relay fence, run with
 * `node --test`.
 *
 * The relay balances one model across several upstream pools, and most of them
 * validate a tool's `parameters` against a meta-schema in which `required`
 * must be an explicit array. The harness serializes a tool with no required
 * parameters as `{"type":"object","properties":{}}` — no `required` at all —
 * and those pools take the missing array as `null` and reject the request:
 * for an empty-parameter tool as `Invalid schema for function 'get_goal':
 * null is not of type "array"`, and otherwise as a bare «Upstream rejected
 * the request as invalid».
 *
 * These tests exercise the fence's fill against a local HTTP server rather
 * than the relay, because what needs proving is exactly the wire shape:
 * object schemas without a `required` array gain one, everything else in the
 * body is preserved, and bodies that need nothing are not rebuilt at all.
 * Whether every relay pool accepts the filled shape was probed live: the
 * captured harness request failed 7 of 8 identical sends unpatched and passed
 * 16 of 16 patched.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const SENTINEL = 'relay.agentrouter.internal'

/** Bodies the echo server saw, most recent last. */
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
      seen.push({ host: req.headers.host, path: req.url, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  host = `127.0.0.1:${server.address().port}`
})

after(() => new Promise((resolve) => server.close(resolve)))

/**
 * Activate the plugin against the echo endpoint with a stub Cordis context.
 * @returns {() => void} the disposer that restores the replaced fetch.
 */
async function activate() {
  const { apply, Config } = await import('../lib/index.js')
  const entry = Config({ endpoints: { cn: host, intl: host }, sentinel: SENTINEL, announce: false })
  const disposers = []
  apply(
    {
      effect(fn) {
        disposers.push(fn() ?? (() => {}))
      },
      inject(_services, callback) {
        callback({
          settings: {
            installSection(_owner, _ns, _schema, _entry, hooks) {
              hooks.setSource(() => entry)
              hooks.onChange()
            },
          },
          effect(fn) {
            disposers.push(fn() ?? (() => {}))
          },
        })
      },
      fiber: { state: 2 },
      logger: { info() {}, warn() {} },
    },
    entry,
  )
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

test('tool schemas reach the wire with an explicit required array', async () => {
  const dispose = await activate()
  try {
    const res = await fetch(`http://${SENTINEL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'ok' }],
        tools: [
          // The harness shape for a tool with no required parameters.
          { type: 'function', function: { name: 'get_goal', description: 'Read the goal.', parameters: { type: 'object', properties: {} }, strict: false } },
          // A tool whose nested object schema also lacks `required`.
          { type: 'function', function: { name: 'write', description: 'Write.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
          // Already-explicit schemas must keep their declared requiredness.
          { type: 'function', function: { name: 'edit', description: 'Edit.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
        ],
      }),
    })
    assert.equal(res.status, 200)
    await res.json()
  } finally {
    dispose()
  }
  const sent = JSON.parse(seen.at(-1).body)
  assert.deepEqual(
    sent.tools.find((tool) => tool.function.name === 'get_goal').function.parameters,
    { type: 'object', properties: {}, required: [] },
    'an absent required becomes an explicit empty array',
  )
  assert.deepEqual(
    sent.tools.find((tool) => tool.function.name === 'write').function.parameters,
    { type: 'object', properties: { path: { type: 'string' } }, required: [] },
    'a partial schema is filled too',
  )
  assert.deepEqual(
    sent.tools.find((tool) => tool.function.name === 'edit').function.parameters,
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    'a declared required array is left alone',
  )
  assert.equal(sent.model, 'deepseek-v4-flash', 'everything around the schemas is preserved')
  assert.equal(sent.messages.length, 1, 'the messages are preserved')
})

test('bodies that need no fill are not rebuilt', async () => {
  const dispose = await activate()
  const withoutTools = '{"model":"claude-opus-5","messages":[]}'
  const withCompleteSchema =
    '{"model":"deepseek-v4-flash","tools":[{"type":"function","function":{"name":"edit","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]}'
  try {
    for (const body of [withoutTools, withCompleteSchema]) {
      const res = await fetch(`http://${SENTINEL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      assert.equal(res.status, 200)
      await res.json()
      assert.equal(seen.at(-1).body, body, 'the body must pass through byte-for-byte')
    }
  } finally {
    dispose()
  }
})

test('the patch is surgical about what it touches', async () => {
  const { relayToolSchemaPatch } = await import('../lib/index.js')
  // A strict-mode tool's `required` must name every property instead, so it is
  // left to its author.
  const strictTool = JSON.stringify({
    tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: { a: { type: 'string' } } }, strict: true } }],
  })
  assert.equal(relayToolSchemaPatch(strictTool), undefined, 'strict tools are not filled')
  // Unparsable and tool-less bodies pass through as undefined.
  assert.equal(relayToolSchemaPatch('not json'), undefined)
  assert.equal(relayToolSchemaPatch('{"model":"x","messages":[]}'), undefined)
  // Filling is idempotent: a second pass finds nothing to change.
  const once = relayToolSchemaPatch(
    JSON.stringify({ tools: [{ type: 'function', function: { name: 'get_goal', parameters: { type: 'object', properties: {} } } }] }),
  )
  assert.notEqual(once, undefined)
  assert.equal(relayToolSchemaPatch(once), undefined)
})
