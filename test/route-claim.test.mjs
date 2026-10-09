/**
 * Behavioural tests for the route claim.
 *
 * The claim exists because a profile's patch layer replaces the whole
 * `llm-pi-ai.providers` dict rather than merging into it, so a profile that
 * declares a provider of its own — the shipped `desktop` profile does — leaves
 * this bundle's route with no adapter and every `agentrouter` call failing
 * `NO_ADAPTER`.
 *
 * Two mechanisms, and the split matters. `withRelayRoute` is the merge itself,
 * applied through `watchRelayRoute` on every resolution of the `llm-pi-ai`
 * config; that is what keeps the route present for the whole session, because
 * the host re-reads the profile patch file shortly after boot and rebuilds every
 * entry from it — a single write is reverted there, invisibly, after the first
 * request has already succeeded. `claimRelayRoute` is only the early nudge that
 * forces one resolution at activation, since `llm-pi-ai` has already registered
 * its routes by then.
 *
 * What needs proving: a displaced route is merged back *and the profile's own
 * routes survive it*, a route the profile genuinely redefined is not fought
 * over, the merge is idempotent so a repeated resolution cannot grow the config,
 * and the hook only touches the entry it owns.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const PI_AI_ID = 'llm-pi-ai'
const PI_AI_NAME = '@deepseek-ai/dsh-llm-pi-ai'

/**
 * A stub loader holding one `llm-pi-ai` entry.
 *
 * `update` mirrors the loader's own contract for a volatile-only change: the
 * named option keys are assigned onto the entry in place and no write-back
 * occurs, so a test can assert both the new value and the absence of
 * persistence.
 *
 * @param {object} config - the entry's composed config.
 * @param {{ fail?: boolean }} [options] - make the update reject.
 * @returns {{ctx: object, entry: object}} the stub and its state.
 */
function stubLoader(config, options = {}) {
  const entry = {
    options: { id: PI_AI_ID, name: PI_AI_NAME, config },
    updates: [],
    async update(next) {
      this.updates.push(next)
      if (options.fail === true) throw new Error('entry is not configurable')
      for (const [key, value] of Object.entries(next)) this.options[key] = value
    },
  }
  const ctx = {
    get(name) {
      if (name !== 'loader') return undefined
      return {
        entries: () => [entry],
      }
    },
  }
  return { ctx, entry }
}

test('a route the profile patch displaced is re-declared, keeping the profile own routes', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const { ctx, entry } = stubLoader({
    providers: { rina: { displayName: 'Rina', api: 'openai-completions', models: [{ id: 'x' }] } },
  })
  const outcome = await claimRelayRoute(ctx)
  assert.equal(outcome, 'claimed')
  const providers = entry.options.config.providers
  assert.ok(providers.rina, 'the profile route must survive the claim')
  assert.equal(providers.agentrouter.displayName, 'AgentRouter')
  assert.equal(providers.agentrouter.apiKeyEnv, 'AGENTROUTER_API_KEY')
  assert.equal(new URL(providers.agentrouter.baseURL).host, 'relay.agentrouter.internal')
})

test('an intact route is left exactly as the profile declared it', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const mine = { displayName: 'Renamed by the deployment', api: 'openai-completions', models: [{ id: 'only' }] }
  const { ctx, entry } = stubLoader({ providers: { agentrouter: mine } })
  const outcome = await claimRelayRoute(ctx)
  assert.equal(outcome, 'declared')
  assert.equal(entry.updates.length, 0, 'an intact route must not be rewritten')
  assert.equal(entry.options.config.providers.agentrouter, mine, 'the deployment value must stand')
})

test('the claim survives a profile whose providers dict is the only thing there', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const { ctx, entry } = stubLoader({ providers: {} })
  assert.equal(await claimRelayRoute(ctx), 'claimed')
  assert.deepEqual(Object.keys(entry.options.config.providers), ['agentrouter'])
})

test('other llm-pi-ai config beside providers is preserved', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const { ctx, entry } = stubLoader({
    providers: { other: { api: 'openai-completions', models: [{ id: 'm' }] } },
    modelDiscovery: { enabled: true },
  })
  assert.equal(await claimRelayRoute(ctx), 'claimed')
  assert.deepEqual(entry.options.config.modelDiscovery, { enabled: true })
  assert.deepEqual(Object.keys(entry.options.config.providers).sort(), ['agentrouter', 'other'])
})

test('a host with no loader is reported absent, not failed', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  assert.equal(await claimRelayRoute({ get: () => undefined }), 'absent')
})

test('an entry the profile made unconfigurable reports failed rather than throwing', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const { ctx } = stubLoader({ providers: {} }, { fail: true })
  assert.equal(await claimRelayRoute(ctx), 'failed')
})

test('an absent providers dict is claimed into, since it serves no routes at all', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const { ctx, entry } = stubLoader({})
  assert.equal(await claimRelayRoute(ctx), 'claimed')
  assert.deepEqual(Object.keys(entry.options.config.providers), ['agentrouter'])
})

test('an unusable providers value is reported rather than overwritten', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const { ctx, entry } = stubLoader({ providers: ['not', 'a', 'dict'] })
  assert.equal(await claimRelayRoute(ctx), 'unusable')
  assert.equal(entry.updates.length, 0, 'a malformed dict is the profile problem to report, not to paper over')
})

test('an llm-pi-ai entry under another id is not the entry the claim touches', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const entry = {
    options: { id: 'pi-ai-second', name: PI_AI_NAME, config: { providers: {} } },
    updates: [],
    async update(next) {
      this.updates.push(next)
    },
  }
  const ctx = { get: () => ({ entries: () => [entry] }) }
  assert.equal(await claimRelayRoute(ctx), 'absent')
  assert.equal(entry.updates.length, 0)
})

test('an entry whose name differs is not the entry the claim touches', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const entry = {
    options: { id: PI_AI_ID, name: '@example/not-pi-ai', config: { providers: {} } },
    updates: [],
    async update(next) {
      this.updates.push(next)
    },
  }
  const ctx = { get: () => ({ entries: () => [entry] }) }
  assert.equal(await claimRelayRoute(ctx), 'absent')
  assert.equal(entry.updates.length, 0)
})

test('the claim hands the loader a config it may keep, not a live reference into the route', async () => {
  const { claimRelayRoute } = await import('../lib/index.js')
  const { AGENTROUTER_ROUTE } = await import('../lib/route.js')
  const { ctx, entry } = stubLoader({ providers: {} })
  assert.equal(await claimRelayRoute(ctx), 'claimed')
  const handed = entry.options.config.providers.agentrouter
  assert.notEqual(handed, AGENTROUTER_ROUTE, 'the module value must not be mutated by a later edit')
  assert.deepEqual(handed, AGENTROUTER_ROUTE)
})

/**
 * A stub Cordis context recording waterfall listeners.
 *
 * `on` mirrors the loader's `internal/config` waterfall shape: each listener is
 * handed the config and a `next` that yields the value the previous listener
 * returned, and its own return value becomes the next listener's input.
 *
 * @returns {{ctx: object, resolve: (entry: object, config: object) => object}} the
 *   stub and a driver that runs one resolution for one entry.
 */
function stubWaterfall() {
  const listeners = []
  const ctx = {
    on(name, listener) {
      assert.equal(name, 'internal/config')
      listeners.push(listener)
      return () => {
        listeners.splice(listeners.indexOf(listener), 1)
      }
    },
  }
  return {
    ctx,
    resolve(entry, config) {
      let value = config
      const scope = { entry }
      for (const listener of listeners) value = listener.call(scope, config, () => value) ?? value
      return value
    },
  }
}

test('the resolution hook merges the route back into a displaced providers dict', async () => {
  const { watchRelayRoute } = await import('../lib/index.js')
  const { ctx, resolve } = stubWaterfall()
  watchRelayRoute(ctx)
  const entry = { options: { id: PI_AI_ID, name: PI_AI_NAME } }
  const out = resolve(entry, { providers: { rina: { api: 'openai-completions', models: [{ id: 'x' }] } } })
  assert.deepEqual(Object.keys(out.providers).sort(), ['agentrouter', 'rina'])
  assert.equal(out.providers.agentrouter.apiKeyEnv, 'AGENTROUTER_API_KEY')
})

test('the resolution hook is idempotent across repeated resolutions', async () => {
  const { watchRelayRoute } = await import('../lib/index.js')
  const { ctx, resolve } = stubWaterfall()
  watchRelayRoute(ctx)
  const entry = { options: { id: PI_AI_ID, name: PI_AI_NAME } }
  const first = resolve(entry, { providers: {} })
  const second = resolve(entry, first)
  const third = resolve(entry, second)
  assert.deepEqual(Object.keys(third.providers), ['agentrouter'])
  assert.deepEqual(third.providers.agentrouter, first.providers.agentrouter)
})

test('the resolution hook leaves an entry it does not own untouched', async () => {
  const { watchRelayRoute } = await import('../lib/index.js')
  const { ctx, resolve } = stubWaterfall()
  watchRelayRoute(ctx)
  const other = { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek' } }
  const config = { providers: {} }
  assert.equal(resolve(other, config), config, 'an unrelated entry must be passed through by identity')
})

test('the resolution hook ignores an entry reusing the id under another name', async () => {
  const { watchRelayRoute } = await import('../lib/index.js')
  const { ctx, resolve } = stubWaterfall()
  watchRelayRoute(ctx)
  const impostor = { options: { id: PI_AI_ID, name: '@example/not-pi-ai' } }
  const config = { providers: {} }
  assert.equal(resolve(impostor, config), config)
})

test('the resolution hook does not fight a route the profile declared itself', async () => {
  const { watchRelayRoute } = await import('../lib/index.js')
  const { ctx, resolve } = stubWaterfall()
  watchRelayRoute(ctx)
  const entry = { options: { id: PI_AI_ID, name: PI_AI_NAME } }
  const mine = { displayName: 'Renamed by the deployment', models: [{ id: 'only' }] }
  const out = resolve(entry, { providers: { agentrouter: mine } })
  assert.equal(out.providers.agentrouter, mine, 'the deployment value must stand')
})

test('the hook is disposed with its fiber, so a reload does not stack listeners', async () => {
  const { watchRelayRoute } = await import('../lib/index.js')
  const { ctx, resolve } = stubWaterfall()
  const dispose = watchRelayRoute(ctx)
  dispose()
  const entry = { options: { id: PI_AI_ID, name: PI_AI_NAME } }
  const config = { providers: {} }
  assert.equal(resolve(entry, config), config, 'after disposal the hook must not merge anything')
})
