/**
 * Behavioural tests for the browser half, run with `node --test`.
 *
 * The bundle is hand-written in the loader's lazy-CJS factory format (the
 * `clientBundle` tsdown preset that normally emits it is not published), so the
 * things that could silently break are exactly the ones a build would have
 * caught: the registration protocol, the shape of what the factory exports, and
 * the slot registration that makes the page appear.
 *
 * The page is registered explicitly rather than left to a schema-reflecting
 * settings plane. `settings.describe` reports `autoGenerate` "for clients that
 * build pages from the schema", and the shipped clients do not — so a browser
 * half that registers nothing renders nothing, which is precisely the bug these
 * tests exist to keep out.
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
  }
  // The bundle is a classic script whose only free variable is the loader
  // facade; a Function wrapper is the smallest honest stand-in.
  new Function('window', 'document', source)(sandbox, undefined)
  assert.ok(registered !== undefined, 'the bundle must call window.__ModuleLoader__.load')
  const required = []
  const exports_ = registered.factory((specifier) => {
    required.push(specifier)
    // The page builds elements through React and the shared form primitives;
    // the factory only reads these at render time, so inert stand-ins suffice.
    if (specifier === 'react') return { useState: (value) => [value, () => {}], createElement: () => ({}) }
    return {}
  })
  return { registered, exports: exports_, required }
}

test('the bundle registers under its package id', () => {
  const { registered } = loadBundle()
  assert.equal(registered.id, 'dsh-llm-agentrouter', 'the id must match the package name the Host scans')
})

test('the browser half declares the services its page needs', () => {
  const { exports } = loadBundle()
  assert.deepEqual(
    exports.inject,
    ['slots', 'locale', 'configForms'],
    'the page registers into a slot, reads copy from a dictionary, and binds the settings namespace',
  )
  assert.equal(typeof exports.apply, 'function')
})

test('the browser half requires the render primitives', () => {
  const { required } = loadBundle()
  assert.ok(required.includes('react'), 'the page builds elements through React')
  assert.ok(
    required.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'the shared settings form and its controls come from the primitives package',
  )
})

test('apply registers the page while the Host serves the namespace', () => {
  const { exports } = loadBundle()
  const registered = []
  const injected = []
  const watched = []
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    configForms: {
      whileServed: (namespaces, register) => {
        watched.push(...namespaces)
        // Serve the namespace, as a mounted Host half does.
        const dispose = register(new Set(namespaces))
        return typeof dispose === 'function' ? dispose : () => {}
      },
    },
    slots: {
      inject: (name, fn) => {
        injected.push(name)
        return fn()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
  }

  exports.apply(ctx)

  assert.deepEqual(watched, [exports.SETTINGS_NS], 'the page follows the namespace the Host half registers')
  assert.deepEqual(injected, ['plugins.item'], 'the page is a card on the Plugins page')
  assert.equal(registered.length, 1, 'exactly one page is registered')
  assert.equal(registered[0].options.id, exports.SETTINGS_NS, 'the entry id is the namespace, so the Host can address it')
  assert.equal(typeof registered[0].component, 'function', 'the entry renders a component')
})

test('the browser half addresses the namespace the Host half registers', () => {
  const { exports } = loadBundle()
  assert.equal(
    exports.SETTINGS_NS,
    'llm-agentrouter',
    'diagnostics and the bundle patch must name the same namespace',
  )
})
