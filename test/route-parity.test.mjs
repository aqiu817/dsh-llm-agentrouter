/**
 * The route the fence re-declares at runtime must be the route the bundle
 * patch declares.
 *
 * `lib/route.js` exists because a profile's own patch layer replaces the whole
 * `llm-pi-ai.providers` dict, dropping this bundle's route — so the route has to
 * be re-added at runtime, and the runtime copy is what every desktop install
 * actually uses. A second copy of a 2 KB route is exactly the kind of thing that
 * drifts: a model added to the patch and not to the module would be invisible on
 * desktop while working everywhere else. These tests read both and compare.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))

/** The `agentrouter` route as the bundle patch declares it. */
function declaredRoute() {
  const rows = yaml.load(readFileSync(patchPath, 'utf8'))
  const patch = rows.find((row) => row.id === 'llm-pi-ai')
  assert.ok(patch, 'cordis.patch.yml must declare the llm-pi-ai patch')
  const route = patch.config?.providers?.agentrouter
  assert.ok(route, 'cordis.patch.yml must declare the agentrouter route')
  return route
}

test('the runtime route equals the route the bundle patch declares', async () => {
  const { AGENTROUTER_ROUTE } = await import('../lib/route.js')
  assert.deepEqual(AGENTROUTER_ROUTE, declaredRoute())
})

test('the runtime route addresses the sentinel the fence rewrites', async () => {
  const { AGENTROUTER_ROUTE } = await import('../lib/route.js')
  const { Config } = await import('../lib/index.js')
  const sentinel = Config({}).sentinel
  assert.equal(new URL(AGENTROUTER_ROUTE.baseURL).host, sentinel)
})

test('the runtime route authenticates by credential reference, never by literal key', async () => {
  const { AGENTROUTER_ROUTE } = await import('../lib/route.js')
  assert.equal(AGENTROUTER_ROUTE.apiKeyEnv, 'AGENTROUTER_API_KEY')
  assert.equal(AGENTROUTER_ROUTE.headers, undefined, 'no literal header may carry a secret')
})

test('the route the runtime module names is the entry the loader mounts', async () => {
  const { PI_AI_ENTRY, AGENTROUTER_PROVIDER } = await import('../lib/route.js')
  const rows = yaml.load(readFileSync(patchPath, 'utf8'))
  const patch = rows.find((row) => row.id === PI_AI_ENTRY.id)
  assert.ok(patch, `no loader entry with id ${PI_AI_ENTRY.id}`)
  assert.equal(patch.name, PI_AI_ENTRY.name)
  assert.ok(patch.config.providers[AGENTROUTER_PROVIDER], 'the entry must carry the claimed route')
})
