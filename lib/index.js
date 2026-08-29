import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'

/**
 * dsh-llm-agentrouter — the runtime half of the bundle of the same name.
 *
 * The bundle's `cordis.patch.yml` declares ONE relay route on the pi-ai adapter
 * (`llm-pi-ai`); everything a request needs — protocol, model catalog, reasoning
 * levels — is configuration there, not code.
 *
 * This plugin owns the two things that configuration cannot express, both of
 * which are rewrites of the same outbound request:
 *
 * 1. **The User-Agent.** The relay authenticates its *client* by `User-Agent`,
 *    accepting only the exact value it requires, and `dsh-llm-pi-ai`
 *    deliberately strips any profile header colliding with
 *    its own attribution before appending
 *    `user-agent: deepseek-harness/<version>`. Attribution is mandatory by
 *    design ("a white-label deployment may replace it, but not suppress it"), so
 *    the substitution has to happen below the adapter — at the `fetch` the
 *    provider SDK resolves from the global scope when it builds its client.
 *
 * 2. **The endpoint.** The relay serves the same models at a domestic and an
 *    international origin. That is one deployment-wide preference, not a model
 *    property, so it is a single setting here rather than a route per endpoint —
 *    which would list every model twice in the picker. The adapter cannot read
 *    this namespace, so the route's `baseURL` names a deliberately unresolvable
 *    sentinel host and the fence substitutes the chosen origin on the way out.
 *
 * The fence is therefore deliberately narrow: it rewrites one header and, for
 * the sentinel alone, one origin; every other request goes to the previous
 * `fetch` untouched. It is installed through `ctx.effect()`, so stopping or
 * reloading the plugin restores the `fetch` it replaced.
 *
 * @module dsh-llm-agentrouter
 */

/** Stable Cordis plugin name. */
const name = 'llm-agentrouter'

/**
 * Settings namespace this plugin owns.
 *
 * It is also the key the browser half registers its card under, so the two
 * halves meet here without either importing the other.
 */
const AGENTROUTER_SETTINGS_NAMESPACE = settingsNamespace('llm-agentrouter')

const Config = z.object({
  /**
   * Which relay origin outbound requests are sent to. The whole point of the
   * plugin's settings card: one choice, applied to every model on the route.
   */
  endpoint: z
    .union([z.const('cn'), z.const('intl')])
    .default('cn')
    .description('relay endpoint requests are sent to: cn (domestic) or intl (international)'),
  /**
   * Host per endpoint key. Configuration rather than a constant so a moved
   * origin is a settings edit, not a release.
   */
  endpoints: z
    .dict(z.string())
    .default({ cn: 'ps.air-outer.com', intl: 'agentrouter.org' })
    .description('host for each endpoint key'),
  /**
   * The host the route's `baseURL` names. Requests to it are rewritten to the
   * selected endpoint; it must stay unresolvable so an unfenced request fails
   * loudly instead of reaching some real server (`.internal` is reserved).
   */
  sentinel: z
    .string()
    .default('relay.agentrouter.internal')
    .description('placeholder host in the route baseURL that the fence replaces with the selected endpoint'),
  /**
   * The exact User-Agent the relay accepts. It is the whole authentication of
   * the client (the API key authenticates the account), so it is configuration
   * rather than a constant: the relay may require a different value later.
   */
  userAgent: z
    .string()
    .default('claude-cli/2.1.161 (external, cli)')
    .description('User-Agent value sent to the relay in place of the harness attribution'),
  /** Report the installed fence once on activation. */
  announce: z.boolean().default(true),
  /**
   * Hint appended to a 402 quota error from the relay. The relay answers
   * Claude / GPT budget-pool exhaustion with HTTP 402 and a JSON error body
   * mislabelled as an event stream; the fence keeps that original message and
   * appends this plain-language explanation. Empty string disables it.
   */
  quotaHint: z
    .string()
    .default('Claude / GPT 本批额度已用完，请等待下一批投放。')
    .description('text appended to relay 402 quota errors'),
})

/**
 * Resolve a `fetch` argument to its URL without consuming a request body.
 * @param {unknown} input - the first `fetch` argument.
 * @returns {URL | undefined} the parsed URL, or undefined when it is not one.
 */
function urlOf(input) {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    if (typeof input === 'object' && input !== null && typeof input.url === 'string') return new URL(input.url)
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The hosts one resolved section wants rewritten, and how.
 *
 * Derived per request from the live section so a settings change takes effect on
 * the next call with no reload. Endpoint hosts are included as themselves: a
 * request already addressed to a real relay origin still needs the User-Agent.
 *
 * @param {ReturnType<typeof Config>} config - the resolved section.
 * @returns {Map<string, string>} lowercase source host to destination host.
 */
function routingTable(config) {
  const table = new Map()
  const selected = config.endpoints[config.endpoint]
  const sentinel = config.sentinel.trim().toLowerCase()
  if (sentinel.length > 0 && typeof selected === 'string' && selected.trim().length > 0) {
    table.set(sentinel, selected.trim())
  }
  for (const host of Object.values(config.endpoints)) {
    if (typeof host !== 'string') continue
    const trimmed = host.trim()
    if (trimmed.length > 0) table.set(trimmed.toLowerCase(), trimmed)
  }
  return table
}

/**
 * Wrap one `fetch` so relay requests carry the relay User-Agent, and sentinel
 * requests additionally go to the selected endpoint.
 *
 * The wrapper never reads or rebuilds a body as a rule: for the shape every
 * provider SDK in this harness uses (url plus an init object) it copies
 * `init` and replaces only its headers. A bare `Request` is re-created with
 * `duplex: 'half'` so a streamed body survives the clone.
 *
 * The one exception is a relay 402 quota-exhaustion response: the body is a
 * small JSON error body mislabelled as `text/event-stream`, which provider
 * SDKs otherwise surface as an opaque transport failure. The fence reads that
 * body, keeps the original error message, appends the configured hint, and
 * rebuilds it as `application/json`. Every other response is left untouched.
 *
 * @param {typeof fetch} native - the fetch this wrapper delegates to.
 * @param {() => ReturnType<typeof Config>} current - reads the live section.
 * @returns {typeof fetch} the wrapping fetch.
 */
function fenceFetch(native, current) {
  return function agentRouterFetch(input, init) {
    const url = urlOf(input)
    if (url === undefined) return native(input, init)

    const config = current()
    const destination = routingTable(config).get(url.host.toLowerCase())
    if (destination === undefined) return native(input, init)

    const isRequest = typeof Request === 'function' && input instanceof Request
    const headers = new Headers(init?.headers ?? (isRequest ? input.headers : undefined))
    headers.set('user-agent', config.userAgent)

    // Same host means the sentinel was not involved: rewrite the header only,
    // and leave the caller's own URL object or Request identity alone.
    let pending
    if (destination.toLowerCase() === url.host.toLowerCase()) {
      if (isRequest && init === undefined) pending = native(new Request(input, { headers, duplex: 'half' }))
      else pending = native(input, { ...init, headers })
    } else {
      const target = new URL(url)
      target.host = destination
      if (isRequest) pending = native(new Request(target, { ...(init ?? {}), ...requestInitOf(input), headers, duplex: 'half' }))
      else pending = native(target, { ...init, headers })
    }

    // The one response this wrapper rewrites: the relay answers Claude / GPT
    // budget-pool exhaustion with HTTP 402 and a JSON error body mislabelled
    // as an event stream, which provider SDKs otherwise surface as an opaque
    // transport failure. Annotate those with the configured hint; every other
    // response passes through untouched.
    return config.quotaHint === '' ? pending : annotateQuotaError(pending, config.quotaHint)
  }
}

/**
 * The relay answers Claude / GPT budget-pool exhaustion with HTTP 402 and a
 * JSON error body mislabelled as 'text/event-stream'; left alone, provider
 * SDKs surface it as an opaque transport failure rather than the API error it
 * is. This rebuilds such a response as 'application/json', keeping the
 * original error message and appending the hint. Every other response passes
 * through untouched.
 *
 * @param {Promise<Response>} pending - the relay fetch promise.
 * @param {string} hint - text appended to the original error message; empty
 *   disables the rewrite (the caller should not call this then).
 * @returns {Promise<Response>} the (possibly rebuilt) response.
 */
function annotateQuotaError(pending, hint) {
  return pending.then((response) => {
    if (response.status !== 402) return response
    const type = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!type.includes('event-stream') && !type.includes('json')) return response
    return response.text().then((text) => {
      let parsed
      let message
      try {
        parsed = JSON.parse(text)
        message = parsed?.error?.message
      } catch {
        message = undefined
      }
      const headers = new Headers(response.headers)
      if (typeof message !== 'string' || message.length === 0) {
        // Not a JSON error body; hand the bytes back unchanged.
        return new Response(text, { status: response.status, statusText: response.statusText, headers })
      }
      headers.set('content-type', 'application/json')
      // Only annotate quota-exhaustion errors; other 402s pass through with
      // the original body so the provider SDK builds its own error message.
      if (/\b(?:quota|budget)\b/i.test(message)) {
        parsed.error.message = message + '\n' + hint
      }
      return new Response(JSON.stringify(parsed), { status: response.status, statusText: response.statusText, headers })
    })
  })
}

/**
 * The fields of a `Request` that must survive re-addressing it.
 *
 * `new Request(url, request)` is not available — the second argument must be an
 * init — so the parts a relay call depends on are copied explicitly. The body is
 * passed by reference, never read.
 *
 * @param {Request} request - the request being re-addressed.
 * @returns {RequestInit} an init carrying its method, body, and transfer flags.
 */
function requestInitOf(request) {
  return {
    method: request.method,
    ...(request.body === null || request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    credentials: request.credentials,
    redirect: request.redirect,
    referrer: request.referrer,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
  }
}

/**
 * Install the relay fence and expose its endpoint choice as a settings section.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {ReturnType<typeof Config>} config - resolved entry configuration.
 */
function apply(ctx, config) {
  // The section is the authority while a settings service exists; the composed
  // entry is the fallback, so the fence works identically with no settings
  // plane at all (headless, or before the service mounts).
  let current = () => config
  installSettingsSection(ctx, AGENTROUTER_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {},
  })

  ctx.effect(() => {
    const previous = globalThis.fetch
    if (typeof previous !== 'function') {
      ctx.logger.warn('llm-agentrouter: no global fetch to fence; relay requests will be unroutable and rejected')
      return () => {}
    }
    const fenced = fenceFetch(previous, () => current())
    globalThis.fetch = fenced
    return () => {
      // Restore only what this plugin installed: a later wrapper layered on top
      // owns the global now, and clobbering it would drop that one's rewrite.
      if (globalThis.fetch === fenced) globalThis.fetch = previous
    }
  })

  if (config.announce) {
    const table = routingTable(config)
    ctx.logger.info(
      'llm-agentrouter: endpoint %c (%c), sending %c',
      config.endpoint,
      table.get(config.sentinel.trim().toLowerCase()) ?? 'unrouted',
      config.userAgent,
    )
  }
}

export { AGENTROUTER_SETTINGS_NAMESPACE, Config, apply, name }
