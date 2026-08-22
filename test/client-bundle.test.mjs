/**
 * Behavioural tests for the browser half, run with `node --test`.
 *
 * The bundle is hand-written in the loader's lazy-CJS factory format (the
 * `clientBundle` tsdown preset that normally emits it is not published), so the
 * things that could silently break are exactly the ones a build would have
 * caught: the registration protocol, the module specifiers it requires, and
 * whether the card renders and writes the field it claims to own.
 *
 * The bundle is executed against a stub loader and stub services, then rendered
 * with `react-test-renderer` — no browser, no DSH shell. The card subscribes to
 * its section through `useSyncExternalStore`, so it is rendered as a component
 * rather than called as a function.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'

const require_ = createRequire(import.meta.url)

/**
 * Execute the bundle the way the client module loader does and return what it
 * registered plus the exports its factory produced.
 *
 * @returns {{registered: object, exports: object}} the load call and its module.
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
  const resolved = new Map([
    ['react', require_('react')],
    ['react/jsx-runtime', require_('react/jsx-runtime')],
  ])
  const exports_ = registered.factory((specifier) => {
    const module = resolved.get(specifier)
    assert.ok(module !== undefined, `the bundle required an unavailable module: ${specifier}`)
    return module
  })
  return { registered, exports: exports_ }
}

/**
 * A settings scope stub with the contract's snapshot shape.
 * @param {object} overrides - snapshot fields overriding the ready defaults.
 * @returns {object} the scope plus the writes it recorded.
 */
function stubScope(overrides = {}) {
  const writes = []
  let snapshot = {
    status: 'ready',
    value: { endpoint: 'cn', endpoints: { cn: 'ps.air-outer.com', intl: 'agentrouter.org' } },
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...overrides,
  }
  return {
    writes,
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: (field, value) => {
      writes.push({ field, value })
      snapshot = { ...snapshot, value: { ...snapshot.value, [field]: value } }
      return Promise.resolve()
    },
    unset: () => Promise.resolve(),
  }
}

/**
 * Render the card and return its tree.
 * @param {object} scope - the settings scope stub it reads.
 * @returns {Promise<object>} the react-test-renderer tree.
 */
async function renderCard(exports_, scope) {
  let tree
  await act(async () => {
    tree = create(createElement(exports_.EndpointCard, { scope, t: (key) => key }))
  })
  return tree
}

/**
 * The endpoint choices a rendered card offers, keyed by endpoint.
 * @param {object} tree - a rendered card.
 * @returns {Map<string, object>} label props per endpoint.
 */
function choicesOf(tree) {
  const choices = new Map()
  for (const node of tree.root.findAll((node) => node.type === 'label')) {
    const endpoint = node.props['data-endpoint']
    if (endpoint !== undefined) choices.set(endpoint, node)
  }
  return choices
}

test('the bundle registers under its package id and declares the services it uses', () => {
  const { registered, exports } = loadBundle()
  assert.equal(registered.id, 'dsh-llm-agentrouter', 'the id must match the package name the Host scans')
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots', 'locale', 'settingsScope'])
  assert.equal(
    exports.SETTINGS_NS,
    'llm-agentrouter',
    'the browser half must address the namespace the Host half registers',
  )
})

test('apply registers one card keyed on the settings namespace', () => {
  const { exports } = loadBundle()
  const registrations = []
  const injections = []
  const bound = []
  exports.apply({
    effect: (fn) => fn(),
    locale: {
      register: (ns, dictionaries) => {
        bound.push({ ns, locales: Object.keys(dictionaries) })
        return () => {}
      },
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    settingsScope: { bind: (spec) => bound.push(spec) },
    slots: {
      inject: (name, callback) => {
        injections.push(name)
        callback()
      },
      register: (options) => {
        registrations.push(options)
        return () => {}
      },
    },
  })
  assert.deepEqual(injections, ['settings.plugin.item'], 'the card joins the plugin configuration tab')
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].key, 'llm-agentrouter', 'the tab dispatches cards by settings namespace')
  assert.deepEqual(
    bound.find((entry) => entry.locales !== undefined).locales.sort(),
    ['en', 'zh'],
    'both dictionaries ship with the card',
  )
})

test('the two dictionaries cover the same keys', () => {
  // A missing key renders as the key itself in one language only, which no test
  // of the rendered card would notice.
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const keysOf = (name) => {
    const body = source.slice(source.indexOf(`const ${name} = {`))
    return [...body.slice(0, body.indexOf('};')).matchAll(/^\t{3}(\w+):/gm)].map((match) => match[1]).sort()
  }
  assert.deepEqual(keysOf('en'), keysOf('zh'))
})

test('the card renders both endpoints, marks the selected one, and names each host', async () => {
  const { exports } = loadBundle()
  const tree = await renderCard(exports, stubScope())
  const choices = choicesOf(tree)
  assert.deepEqual([...choices.keys()], ['cn', 'intl'], 'both endpoints are offered, domestic first')
  assert.equal(choices.get('cn').props['data-selected'], 'true', 'the stored endpoint is selected')
  assert.equal(choices.get('intl').props['data-selected'], undefined)
  assert.equal(choices.get('cn').props['data-disabled'], undefined, 'a writable ready section allows a switch')

  const hosts = tree.root
    .findAll((node) => node.type === 'span' && node.props.className === 'dshAr_choiceHost')
    .map((node) => node.props.children)
  assert.ok(hosts.includes('ps.air-outer.com'), 'each choice shows the host it means')
  assert.ok(hosts.includes('agentrouter.org'))

  // Each endpoint carries its own guidance, so neither choice is a guess.
  const hints = tree.root
    .findAll((node) => node.type === 'span' && node.props.className === 'dshAr_choiceHint')
    .map((node) => node.props.children)
  assert.deepEqual(hints, ['cnHint', 'intlHint'], 'both endpoints explain when they apply')
})

test('choosing the other endpoint writes exactly the endpoint field', async () => {
  const { exports } = loadBundle()
  const scope = stubScope()
  const tree = await renderCard(exports, scope)
  const radios = tree.root.findAll((node) => node.type === 'input' && node.props.type === 'radio')
  assert.equal(radios.length, 2, 'one radio per endpoint')
  const intl = radios.find((node) => node.props.value === 'intl')
  await act(async () => {
    intl.props.onChange()
  })
  assert.deepEqual(scope.writes, [{ field: 'endpoint', value: 'intl' }], 'one write, one field')
  assert.equal(
    choicesOf(tree).get('intl').props['data-selected'],
    'true',
    'the card follows the section it just wrote',
  )
})

test('an unwritable or unreadable section offers no write', async () => {
  const { exports } = loadBundle()
  for (const overrides of [{ writable: false }, { status: 'loading', value: undefined }, { status: 'unavailable' }]) {
    const scope = stubScope(overrides)
    const tree = await renderCard(exports, scope)
    const where = JSON.stringify(overrides)
    for (const choice of choicesOf(tree).values()) {
      assert.equal(choice.props['data-disabled'], 'true', `${where} must not invite a switch`)
    }
    // Disabled chrome is a hint; refusing the write is the guarantee.
    const other = tree.root
      .findAll((node) => node.type === 'input' && node.props.type === 'radio')
      .find((node) => node.props.value === 'intl')
    await act(async () => {
      other.props.onChange()
    })
    assert.deepEqual(scope.writes, [], `${where} must write nothing`)
  }
})
