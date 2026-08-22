/**
 * Live integration check: the real pi-ai adapter, this bundle's route profile,
 * and the User-Agent fence, streaming one turn from the relay.
 *
 * It is skipped unless both a relay key and the pi-ai package resolve, so the
 * suite still runs offline and on a machine that has no dsh install. What it
 * proves is the thing unit tests cannot: that a hand-declared route of this
 * shape builds, that the fence survives the adapter's own header pass
 * (attribution strips the profile's copy of `user-agent`), and that the relay
 * accepts the result.
 *
 * Provide the key as `AGENTROUTER_API_KEY`. The dsh Models settings page stores
 * it in the managed credentials document instead, which this test also reads —
 * it never prints or logs the value.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require_ = createRequire(import.meta.url)

/**
 * The pi-ai `dist` directory, or undefined when the package is not installed.
 *
 * pi-ai is a transitive dependency of the dsh CLI rather than of this bundle,
 * so there is no single portable specifier for it. Candidates, in order: an
 * explicit override, ordinary resolution from this file, and the dsh install
 * beside the running Node binary.
 *
 * @returns {string | undefined} the absolute dist path.
 */
function piAiDist() {
  const override = process.env.DSH_PI_AI_DIST
  if (override !== undefined && existsSync(override)) return override

  try {
    return join(dirname(require_.resolve('@earendil-works/pi-ai/package.json')), 'dist')
  } catch {
    // Not a dependency here; fall through to the dsh install.
  }

  const globalModules = join(dirname(process.execPath), '..', 'lib', 'node_modules')
  const bundled = join(globalModules, '@deepseek-ai', 'dsh', 'node_modules', '@earendil-works', 'pi-ai', 'dist')
  return existsSync(bundled) ? bundled : undefined
}

/**
 * The relay key from the managed credentials document.
 *
 * Only the reference `AGENTROUTER_API_KEY` is read, and only its presence is
 * ever reported; the value goes straight into the request.
 *
 * @returns {string | undefined} the key, when one is stored.
 */
function storedKey() {
  const home = process.env.DSH_HOME ?? (process.env.HOME === undefined ? undefined : join(process.env.HOME, '.dsh'))
  if (home === undefined) return undefined
  try {
    const yaml = require_('js-yaml')
    const value = yaml.load(readFileSync(join(home, '.credentials.yaml'), 'utf8'))?.refs?.AGENTROUTER_API_KEY
    return typeof value === 'string' ? value : value?.value
  } catch {
    // No document, no js-yaml, or no such reference — the test skips.
    return undefined
  }
}

/**
 * The relay key, or undefined when there is nothing usable.
 *
 * An unset GitHub Actions secret arrives as an empty string rather than as an
 * absent variable, so presence alone is not enough: a blank value must read as
 * absent, or CI would try to authenticate with `Bearer ` and fail a test that
 * was meant to skip.
 *
 * @returns {string | undefined} a non-blank key.
 */
function relayKey() {
  for (const candidate of [process.env.AGENTROUTER_API_KEY, storedKey()]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  }
  return undefined
}

const key = relayKey()
const dist = piAiDist()
const SENTINEL_HOST = 'relay.agentrouter.internal'
// The route's own baseURL: the fence is what makes it reach anything, which is
// exactly the seam this test exercises.
const RELAY_BASE_URL = `https://${SENTINEL_HOST}/v1`
const ENDPOINT = process.env.AGENTROUTER_ENDPOINT ?? 'cn'
const RELAY_HOST = process.env.AGENTROUTER_HOST
const HARNESS_UA = 'deepseek-harness/0.1.1 (+https://github.com/deepseek-ai/deepseek-harness)'

const skip =
  key === undefined ? 'no AGENTROUTER_API_KEY' : dist === undefined ? 'pi-ai is not installed' : false

test('the declared route streams a turn from the relay', { skip }, async () => {
  const { createModels, createProvider } = await import(`${dist}/index.js`)
  // The lazy factory, exactly as `dsh-llm-pi-ai` resolves it from its protocol
  // table: `createProvider` wants the built streams object, not the module.
  const { openAICompletionsApi } = await import(`${dist}/api/openai-completions.lazy.js`)
  const { apply, Config } = await import('../lib/index.js')

  // The fence, activated exactly as the harness activates it: the entry config
  // is the authority when no settings service is present, which is this case.
  const disposers = []
  const config = Config({
    endpoint: ENDPOINT,
    ...(RELAY_HOST === undefined ? {} : { endpoints: { cn: RELAY_HOST, intl: RELAY_HOST } }),
    announce: false,
  })
  apply(
    {
      effect: (fn) => disposers.push(fn() ?? (() => {})),
      // No settings service in this harness, so the injection never fires and
      // the composed entry stays the authority — the headless posture.
      inject: () => {},
      logger: { info() {}, warn() {} },
    },
    config,
  )

  try {
    const provider = createProvider({
      id: 'agentrouter',
      name: 'AgentRouter',
      baseUrl: RELAY_BASE_URL,
      // The same auth shape `dsh-llm-pi-ai` builds for a hand-declared route
      // (`harnessApiKeyAuth`): the harness has already resolved the credential,
      // so this hands it straight to the protocol.
      auth: {
        apiKey: {
          name: 'AgentRouter',
          resolve: ({ credential }) =>
            Promise.resolve({ auth: { apiKey: credential?.key ?? key }, source: 'test' }),
        },
      },
      api: openAICompletionsApi(),
      models: [
        {
          id: 'claude-opus-5',
          name: 'Claude Opus 5',
          api: 'openai-completions',
          provider: 'agentrouter',
          baseUrl: RELAY_BASE_URL,
          input: ['text'],
          // pi-ai's usage accounting reads `cost.tiers`, so a model descriptor
          // needs a cost block even when nothing consumes the number. The real
          // adapter materializes one from its catalog; this restates a zero.
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000000,
          maxTokens: 128000,
          reasoning: true,
          thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
          compat: {
            thinkingFormat: 'openai',
            supportsReasoningEffort: true,
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
            supportsStore: false,
            supportsStrictMode: true,
            supportsUsageInStreaming: true,
          },
        },
      ],
    })

    const models = createModels()
    models.setProvider(provider)
    const model = models.getModel('agentrouter', 'claude-opus-5')

    // The harness sends its attribution User-Agent on every request; the fence
    // is what turns it into the one the relay accepts.
    const stream = models.streamSimple(
      model,
      { messages: [{ role: 'user', content: 'Reply with exactly: ok' }] },
      {
        maxTokens: 32,
        reasoning: 'low',
        headers: { 'user-agent': HARNESS_UA },
      },
    )

    const message = await stream.result()
    assert.notEqual(message.stopReason, 'error', `the relay refused the request: ${message.errorMessage ?? ''}`)
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    assert.match(text.toLowerCase(), /ok/, `expected an answer through the fence, got ${JSON.stringify(text)}`)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
  }
})

test('without the fence the relay rejects the harness User-Agent', { skip: key === undefined ? 'no AGENTROUTER_API_KEY' : false }, async () => {
  // The negative control that gives the test above its meaning: the relay gates
  // on User-Agent alone, so the same key and body must fail unfenced. If this
  // ever passes, the gate is gone and the fence can be retired.
  const { Config } = await import('../lib/index.js')
  const host = Config({ endpoint: ENDPOINT }).endpoints[ENDPOINT]
  const res = await fetch(`https://${host}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      'user-agent': HARNESS_UA,
    },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30000),
  })
  assert.equal(res.status, 401, 'the relay is expected to reject an unfenced client')
  await res.json()
})
