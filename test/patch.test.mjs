/**
 * Tests over the bundle patch, run with `node --test`.
 *
 * The patch is data, so what can rot is its agreement with the code beside it:
 * the sentinel host the fence rewrites, the single route the endpoint switch
 * assumes, and the group name the model picker shows.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

import { Config } from '../lib/index.js'

const patch = load(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
const providers = patch.find((row) => row.id === 'llm-pi-ai').config.providers
const route = providers.agentrouter

test('exactly one relay route is declared', () => {
  assert.deepEqual(Object.keys(providers), ['agentrouter'], 'a second route would double every model in the picker')
})

test('the route baseURL addresses the host the fence rewrites', () => {
  const { sentinel, endpoints } = Config({})
  assert.equal(new URL(route.baseURL).host, sentinel, 'an unrewritten sentinel is the point of the design')
  for (const host of Object.values(endpoints)) {
    assert.notEqual(host, sentinel, 'the sentinel must never be a real endpoint')
  }
})

test('the picker group title is a name, not a notice', () => {
  // The group title is the only string this plugin can put in that menu, which
  // makes it tempting to explain the endpoint there. It is a label: one group,
  // one name. Guidance belongs to the settings card, which owns the switch.
  assert.equal(route.displayName, 'AgentRouter')
})

test('the plugin row is inserted so the fence and the switch actually load', () => {
  const insert = patch.at(-1).insert
  assert.deepEqual(insert, [{ id: 'llm-agentrouter', name: 'dsh-llm-agentrouter' }])
})

test('every model declares the levels the relay was probed with', () => {
  const ids = route.models.map((model) => model.id)
  assert.deepEqual(ids, ['claude-opus-5', 'claude-opus-4-8', 'gpt-5.6-sol', 'gpt-6-astra', 'deepseek-v4-flash'])

  const wire = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  for (const model of route.models) {
    const levels = Object.entries(model.reasoningEfforts)
    assert.ok(
      levels.some(([level]) => level !== 'off'),
      `${model.id} must offer a thinking level`,
    )
    for (const [level, spelling] of levels) {
      if (level === 'off' && spelling === null) continue
      assert.ok(
        wire.includes(spelling),
        `${model.id}.${level} sends "${spelling}", which the relay's enum does not accept`,
      )
    }
  }
})

test('every model in the catalog offers a working Off', () => {
  // Levels are withheld only where the relay rejects them — the retired glm-5.3
  // was such a case (it always thinks). No model in the current catalog is:
  // each declares `off` and was probed with it working.
  for (const model of route.models) {
    assert.ok('off' in model.reasoningEfforts, `${model.id} must offer Off`)
  }
})

test('deepseek-v4-flash can actually stop thinking', () => {
  // Omitting `reasoning_effort` still returns reasoning content for this model,
  // so an empty `off:` would render a switch that changes nothing. Only the
  // relay's own `none` disables it.
  const efforts = route.models.find((model) => model.id === 'deepseek-v4-flash').reasoningEfforts
  assert.equal(efforts.off, 'none')
})

test('deepseek-v4-flash declares the DeepSeek thinking protocol explicitly', () => {
  // The relay serves this model from a DeepSeek-compatible thinking API under
  // its own hostname, so pi-ai cannot infer the protocol from the URL and the
  // route has to say it. Without the replay flag, assistant tool-call history
  // goes out without `reasoning_content` and that upstream rejects the request
  // — only once a tool call has happened, which is why it hides from fresh
  // sessions.
  const compat = route.models.find((model) => model.id === 'deepseek-v4-flash').compat
  assert.equal(compat?.thinkingFormat, 'deepseek')
  assert.equal(compat?.requiresReasoningContentOnAssistantMessages, true)
  assert.equal(compat?.supportsDeveloperRole, false)
  assert.equal(compat?.supportsStore, false)
})
