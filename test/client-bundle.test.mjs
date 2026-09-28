/**
 * Behavioural tests for the browser half, run with `node --test`.
 *
 * The bundle is hand-written in the loader's lazy-CJS factory format (the
 * `clientBundle` tsdown preset that normally emits it is not published), so the
 * things that could silently break are exactly the ones a build would have
 * caught: the registration protocol and the shape of what the factory exports.
 * Since 0.1.7 the card itself is retired — the host reflects the plugin's
 * Config schema into an automatic settings page — so the browser half must be
 * a well-formed no-op: loadable, inert, and still answering for its namespace.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Execute the bundle the way the client module loader does and return what it
 * registered plus the exports its factory produced.
 *
 * @returns {{registered: object, exports: object, required: string[]}} the load
 *   call, its module, and the specifiers it required.
 */
function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let registered
  const sandbox = {
    __ModuleLoader__: {
      load: (row) => {
        registered = row
      },
    },
    document: undefined,
  }
  // The bundle is a classic script whose only free variables are the loader
  // facade and `document`; a Function wrapper is the smallest honest stand-in.
  new Function('window', 'document', source)(sandbox, undefined)
  assert.ok(registered !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  const required = []
  const exports_ = registered.factory((specifier) => {
    required.push(specifier)
    return undefined
  })
  return { registered, exports: exports_, required }
}

test('the bundle registers under its package id', () => {
  const { registered } = loadBundle()
  assert.equal(registered.id, 'dsh-llm-agentrouter', 'the id must match the package name the Host scans')
})

test('the browser half is an inert no-op', () => {
  const { exports, required } = loadBundle()
  assert.deepEqual(exports.inject, [], '0.1.7 has no services for the browser half to inject')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(required, [], 'a retired card needs no modules — not even react')
})

test('apply registers nothing and touches nothing', () => {
  const { exports } = loadBundle()
  const touched = []
  const recording = new Proxy(
    {},
    {
      get: (_, key) => {
        touched.push(String(key))
        return recording
      },
    },
  )
  exports.apply(recording)
  assert.deepEqual(touched, [], 'the automatic page needs no client-side registration')
})

test('the browser half addresses the namespace the Host half registers', () => {
  const { exports } = loadBundle()
  assert.equal(
    exports.SETTINGS_NS,
    'llm-agentrouter',
    'diagnostics and the bundle patch must name the same namespace',
  )
})
