/**
 * The AgentRouter route as a runtime value.
 *
 * This is the route `cordis.patch.yml` declares, in the form the plugin needs
 * to *re-add* at runtime. It exists because a profile's own
 * `llm-pi-ai.providers` patch is applied after every bundle layer, and the
 * loader's patch merge assigns a patch's `config` over the composed one — one
 * level deep, so the whole `providers` dict is replaced rather than merged.
 * A profile that declares any provider of its own therefore drops the
 * `agentrouter` route: the shipped `desktop` profile does exactly that, and so
 * does any profile with a second relay.
 *
 * The fence re-installs the route through the entry's own volatile config, which
 * the adapter observes on the next request. `test/route-parity.test.mjs` asserts
 * this value still equals the patch's, so the two cannot drift apart.
 *
 * @module dsh-llm-agentrouter/route
 */

/** The provider key this bundle owns inside `llm-pi-ai.providers`. */
const AGENTROUTER_PROVIDER = 'agentrouter'

/** The loader entry id and name the route is declared on. */
const PI_AI_ENTRY = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }

/** The route exactly as `cordis.patch.yml` declares it. */
const AGENTROUTER_ROUTE = {
  "displayName": "AgentRouter",
  "apiKeyEnv": "AGENTROUTER_API_KEY",
  "api": "openai-completions",
  "baseURL": "https://relay.agentrouter.internal/v1",
  "defaultInput": [
    "text"
  ],
  "compat": {
    "thinkingFormat": "openai",
    "supportsReasoningEffort": true,
    "supportsDeveloperRole": false,
    "maxTokensField": "max_tokens",
    "supportsStore": false,
    "supportsStrictMode": true,
    "supportsUsageInStreaming": true
  },
  "models": [
    {
      "id": "claude-opus-5",
      "name": "Claude Opus 5",
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "reasoningEfforts": {
        "off": null,
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max"
      }
    },
    {
      "id": "claude-opus-4-8",
      "name": "Claude Opus 4.8",
      "contextWindow": 1000000,
      "maxTokens": 128000,
      "reasoningEfforts": {
        "off": null,
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max"
      }
    },
    {
      "id": "gpt-5.6-sol",
      "name": "GPT 5.6 Sol",
      "contextWindow": 272000,
      "maxTokens": 128000,
      "reasoningEfforts": {
        "off": null,
        "minimal": "minimal",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max"
      }
    },
    {
      "id": "gpt-6-astra",
      "name": "GPT 6 Astra",
      "contextWindow": 272000,
      "maxTokens": 128000,
      "reasoningEfforts": {
        "off": null,
        "minimal": "minimal",
        "low": "low",
        "medium": "medium",
        "high": "high",
        "xhigh": "xhigh",
        "max": "max"
      }
    },
    {
      "id": "deepseek-v4-flash",
      "name": "DeepSeek V4 Flash",
      "contextWindow": 1000000,
      "maxTokens": 256000,
      "compat": {
        "thinkingFormat": "deepseek",
        "requiresReasoningContentOnAssistantMessages": true,
        "supportsDeveloperRole": false,
        "supportsStore": false
      },
      "reasoningEfforts": {
        "off": "none",
        "low": "low",
        "high": "high",
        "max": "max"
      }
    }
  ]
}

export { AGENTROUTER_PROVIDER, AGENTROUTER_ROUTE, PI_AI_ENTRY }
