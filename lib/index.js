import z from '@deepseek-ai/schemastery'
import { directFetch, proxyEnvPresent } from './direct-fetch.js'
import { AGENTROUTER_PROVIDER, AGENTROUTER_ROUTE, PI_AI_ENTRY } from './route.js'

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
 * 3. **The transport.** The relay's WAF challenges datacenter egress — the exit
 *    an `HTTPS_PROXY` hop produces — with a 200 HTML interstitial instead of
 *    the stream, which provider SDKs surface as an opaque transport failure.
 *    dsh installs its proxy dispatcher from the launch environment before
 *    plugins load, so the fence owns the transport for covered endpoints and
 *    sends those requests over a direct `node:http`/`node:https` connection
 *    (see `lib/direct-fetch.js`).
 *
 * 4. **Tool schemas.** The relay balances one model across several upstream
 *    pools, most of which reject a tool schema whose object nodes carry no
 *    explicit `required` array (the harness omits it when no parameter is
 *    required, and one pool reports that as `null is not of type "array"`).
 *    The fence fills `required: []` into outbound tool schemas — a no-op for
 *    endpoints that never required it.
 *
 * 5. **The route's survival.** A profile's own patch layer is applied after
 *    every bundle layer, and the loader assigns a patch's `config` over the
 *    composed one rather than merging it — so a profile that declares any
 *    `llm-pi-ai.providers` of its own replaces the whole dict and drops the
 *    `agentrouter` route this bundle declares. The shipped `desktop` profile
 *    does exactly that, and so does any profile with a second relay. The fence
 *    re-adds its own route through the entry's live config, which the adapter
 *    observes on the next request.
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
const AGENTROUTER_SETTINGS_NAMESPACE = 'llm-agentrouter'

const Config = z.object({
  /**
   * Which relay origin outbound requests are sent to. The whole point of the
   * plugin's settings card: one choice, applied to every model on the route.
   */
  endpoint: z
    .union([z.const('cn'), z.const('intl')])
    .default('cn')
    .description('relay endpoint requests are sent to: cn (domestic) or intl (international)')
    // 0.1.7 reflects only `.volatile()` fields into the settings plane; the
    // other fields stay release/shell-managed and are deliberately not shown.
    .volatile(),
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
   * Which endpoints the fence sends over a direct connection. The relay's WAF
   * challenges datacenter egress — the exit an HTTPS_PROXY hop produces — with
   * a 200 HTML interstitial instead of the stream, so the domestic origin,
   * reachable directly wherever the relay is served, must leave without the
   * process proxy. The international origin is the one that may need the
   * proxy, so it keeps it. No-op on processes launched without proxy
   * variables.
   */
  directEndpoints: z
    .union([z.const('none'), z.const('cn'), z.const('both')])
    .default('cn')
    .description('which endpoint keys bypass a process-level proxy and connect directly'),
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
  /**
   * Re-send a request the relay answered with a transient upstream rejection,
   * without the harness ever seeing the failure.
   *
   * The relay round-robins one model id across upstream channels that disagree
   * about how replayed reasoning must be encoded, so the *same* request
   * succeeds or fails depending on which channel answered; a channel that is
   * briefly unhealthy answers 5xx instead. Both are terminal to the harness —
   * its default retryable set omits `INVALID_REQUEST`, so a 400 ends the turn —
   * which is why the fence, not the adapter, owns this: it already holds the
   * serialized body and can re-send the identical bytes.
   *
   * Off by default: re-sending is only free for a request the relay can serve
   * more than once, and silently hiding a genuine 400 would trade a visible
   * error for a confusing empty turn.
   */
  silentRetry: z
    .boolean()
    .default(false)
    .description('re-send a request the relay rejected as a transient upstream error, hiding the failure from the harness')
    .volatile(),
  /**
   * Total sends one request may make while {@link silentRetry} is on, the first
   * attempt included. A retry only helps if the next channel differs, so a
   * handful is enough; the ceiling keeps a persistently broken route from
   * multiplying every turn.
   */
  silentRetryAttempts: z
    .number()
    .step(1)
    .min(1)
    .max(10)
    .default(3)
    .description('total attempts one relay request may make when silentRetry is enabled')
    .volatile(),
  /**
   * Re-declare this bundle's `agentrouter` route when the profile's own patch
   * layer has displaced it.
   *
   * A profile's patch is applied after every bundle layer and its `config` is
   * assigned over the composed one rather than merged, so a profile declaring
   * *any* provider of its own replaces the whole `llm-pi-ai.providers` dict —
   * including the route below, which then has no adapter and fails every call
   * with `NO_ADAPTER`. The shipped `desktop` profile does this, and so does any
   * profile holding a second relay.
   *
   * On by default because the alternative is a bundle that silently does
   * nothing in exactly the profiles most likely to want it. Off is for a
   * deployment that means to manage the route itself and would rather see the
   * collision than have it resolved underneath it.
   *
   * Read once at activation rather than per request, so it is an ordinary field
   * like {@link announce}: flipping it in the profile patch reloads this fiber
   * and re-runs the claim, which is the only time it can act anyway.
   */
  claimRoute: z
    .boolean()
    .default(true)
    .description('re-declare the agentrouter route when the profile patch layer has replaced it'),
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
 * Unwrap a volatile field reference, if the value is one.
 *
 * 0.1.7 hands `.volatile()` fields out as frozen reference cells (`{ get }`,
 * with the setter kept private): a settings write mutates the cell in place
 * instead of reloading the fiber, so every read must go through `get()` to
 * observe the current choice. Ordinary values pass through untouched.
 *
 * @param {unknown} value - a resolved config field value.
 * @returns {unknown} the plain value behind a volatile cell, else the value.
 */
function resolveVolatile(value) {
  return typeof value === 'object' && value !== null && Object.isFrozen(value) && typeof value.get === 'function'
    ? value.get()
    : value
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
  const selected = config.endpoints[resolveVolatile(config.endpoint)]
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
 * Give every object schema node an explicit `required` array, in place.
 *
 * The relay's upstream pools take `required` literally: absent becomes an
 * invalid `null` under their meta-schema (see {@link relayToolSchemaPatch}).
 * An empty array is semantically identical to an omitted `required`, so the
 * fill cannot change what a conforming endpoint accepts. Every object value
 * is walked — `properties` maps, `items`, and `oneOf` branches included — so
 * nested object schemas are normalized too.
 *
 * @param {unknown} node - a JSON Schema node, or any JSON value reachable
 *   from one.
 * @returns {boolean} whether any node gained a `required` array.
 */
function ensureRequiredArray(node) {
  if (Array.isArray(node)) {
    let changed = false
    for (const item of node) if (ensureRequiredArray(item)) changed = true
    return changed
  }
  if (typeof node !== 'object' || node === null) return false
  let changed = false
  if ((node.type === 'object' || node.properties !== undefined) && !Array.isArray(node.required)) {
    node.required = []
    changed = true
  }
  for (const value of Object.values(node)) if (ensureRequiredArray(value)) changed = true
  return changed
}

/**
 * Patch the `tools` of one outbound relay request body for strict upstreams.
 *
 * @param {string} text - the request body as serialized by the provider SDK.
 * @returns {string | undefined} the re-serialized body when any tool schema
 *   changed, and undefined when the body should pass through byte-for-byte
 *   (unparsable, no tools, nothing to fill, or a `strict: true` tool, whose
 *   `required` must instead name every property and is left to its author).
 */
function relayToolSchemaPatch(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return undefined
  let changed = false
  for (const tool of body.tools) {
    const fn = tool?.function
    if (typeof fn !== 'object' || fn === null || fn.strict === true) continue
    if (typeof fn.parameters !== 'object' || fn.parameters === null) continue
    if (ensureRequiredArray(fn.parameters)) changed = true
  }
  return changed ? JSON.stringify(body) : undefined
}

/**
 * The endpoint key each configured host belongs to.
 *
 * The direct transport is a property of the endpoint — its WAF posture, not
 * the selection — so an explicitly addressed origin keeps its own key even
 * when another endpoint is selected.
 *
 * @param {ReturnType<typeof Config>} config - the resolved section.
 * @returns {Map<string, string>} lowercase host to endpoint key.
 */
function endpointKeyByHost(config) {
  const map = new Map()
  for (const [key, host] of Object.entries(config.endpoints)) {
    if (typeof host !== 'string' || host.trim().length === 0) continue
    map.set(host.trim().toLowerCase(), key)
  }
  return map
}

/**
 * Whether the direct transport sends requests for one endpoint key.
 *
 * @param {'none' | 'cn' | 'both'} directEndpoints - the resolved setting.
 * @param {string} key - the endpoint key the destination host belongs to.
 * @returns {boolean} true when such requests leave without the process proxy.
 */
function bypassCovers(directEndpoints, key) {
  if (directEndpoints === 'both') return true
  if (directEndpoints === 'none') return false
  return directEndpoints === key
}

/**
 * One init shape both transports accept: a Request's own parts when the caller
 * passed a bare Request, the caller's init otherwise, with the rewritten
 * headers last.
 *
 * @param {unknown} input - the first `fetch` argument.
 * @param {RequestInit | undefined} init - the second `fetch` argument.
 * @param {boolean} isRequest - whether `input` is a `Request`.
 * @param {Headers} headers - the rewritten header set.
 * @returns {RequestInit} the init to hand to the chosen transport.
 */
function unifiedInit(input, init, isRequest, headers) {
  if (isRequest) return { ...requestInitOf(input), ...init, headers }
  return { ...init, headers }
}

/**
 * The relay's terminal-looking failures that a second channel usually answers.
 *
 * The relay load-balances one model id across upstream channels that disagree
 * about how replayed reasoning must be encoded, so the same request is accepted
 * or rejected depending on which channel drew it. `INVALID_REQUEST` is absent
 * from the harness's default retryable set, so without this a 400 ends the
 * turn; the body wordings below are the channel-dialect rejections the relay
 * reports as 400 rather than 5xx.
 */
const TRANSIENT_RELAY_STATUS = new Set([500, 502, 503, 504])
const TRANSIENT_RELAY_BODY = /must be passed back to the API|upstream rejected the request as invalid|null is not of type "array"/i

/**
 * Whether one relay response is worth re-sending, rebuilding it when the body
 * had to be read to decide.
 *
 * A 5xx is transient on its face and needs no body read, so its response is
 * returned untouched. A 400 is ambiguous — the relay uses it for channel
 * dialect rejections *and* for genuine bad requests — so only a body matching
 * {@link TRANSIENT_RELAY_BODY} qualifies; reading it consumes the stream, so
 * the response is rebuilt either way to leave the caller something to report.
 *
 * @param {Response} response - one attempt's response.
 * @returns {Promise<{retry: boolean, response: Response}>} the verdict, with a
 *   response the caller may still read.
 */
async function transientRelayRejection(response) {
  if (TRANSIENT_RELAY_STATUS.has(response.status)) return { retry: true, response }
  if (response.status !== 400) return { retry: false, response }
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!type.includes('json') && !type.includes('event-stream')) return { retry: false, response }
  const text = await response.text()
  const rebuilt = new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  })
  return { retry: TRANSIENT_RELAY_BODY.test(text), response: rebuilt }
}

/**
 * Wait between attempts, resolving false when the caller aborted first.
 *
 * @param {number} attempt - 1 for the wait after the first attempt.
 * @param {AbortSignal | undefined} signal - the request's own signal.
 * @returns {Promise<boolean>} whether the next attempt may proceed.
 */
function delayBeforeRetry(attempt, signal) {
  const ms = 200 * attempt
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Re-send one request while the relay keeps answering with a transient
 * rejection, so the harness sees only the final outcome.
 *
 * Each attempt re-invokes `dispatch`, which rebuilds the request from the parts
 * the caller supplied — the identical bytes, which is the point: the failure is
 * the channel that drew the request, not the request. The last attempt's
 * response is returned whatever it is, so a persistently broken route still
 * reports an error rather than hanging.
 *
 * @param {Promise<Response>} first - the already-started first attempt.
 * @param {() => Promise<Response>} dispatch - performs one attempt.
 * @param {number} attempts - total sends allowed, the first included.
 * @param {AbortSignal | undefined} signal - the request's own signal.
 * @param {((attempt: number) => void) | undefined} onRetry - notified before
 *   each re-send.
 * @returns {Promise<Response>} the first non-transient, or the last, response.
 */
async function retryTransient(first, dispatch, attempts, signal, onRetry) {
  const total = Math.max(1, Math.trunc(attempts))
  let pending = first
  for (let attempt = 1; attempt < total; attempt++) {
    const response = await pending
    if (signal?.aborted) return response
    const verdict = await transientRelayRejection(response)
    if (!verdict.retry) return verdict.response
    if (!(await delayBeforeRetry(attempt, signal))) return verdict.response
    onRetry?.(attempt + 1)
    pending = dispatch()
  }
  return pending
}

/**
 * Whether the composed `llm-pi-ai` config already carries this bundle's route.
 *
 * The check is deliberately narrow: it reads the loader entry's own `config`,
 * which is what the adapter resolves profiles from, rather than the plugin's
 * private view of the route.
 *
 * An absent `providers` counts as missing rather than unusable. The adapter's
 * schema defaults it to `{}`, so a profile that replaced the whole `llm-pi-ai`
 * config without naming `providers` serves no routes at all — this bundle's
 * included — and there is nothing to merge into and nothing to protect. A
 * present value of the wrong type is the one case that is genuinely the
 * profile's business: overwriting it would discard whatever it meant.
 *
 * @param {unknown} config - the entry's composed config.
 * @returns {'declared' | 'missing' | 'unusable'} the verdict.
 */
function relayRouteState(config) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return 'unusable'
  const providers = config.providers
  if (providers === undefined) return 'missing'
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return 'unusable'
  return providers[AGENTROUTER_PROVIDER] === undefined ? 'missing' : 'declared'
}

/**
 * Re-declare this bundle's route on the profile's live `llm-pi-ai` entry.
 *
 * A profile's patch layer is applied after every bundle layer and its `config`
 * is assigned over the composed one rather than merged, so one profile-declared
 * provider replaces the whole `llm-pi-ai.providers` dict and this bundle's route
 * goes with it — leaving every `agentrouter` call failing `NO_ADAPTER`. The
 * route is re-added here instead, through the entry's own config.
 *
 * `providers` is a `.volatile()` field, so the loader commits the change into
 * the running fiber's reference cell and announces it on
 * `loader/volatile-update`, which is the same path a settings write takes: the
 * adapter re-registers its routes on the next request, with no restart. The
 * update deliberately does not force a lifecycle pass — a volatile-only change
 * must not bounce the adapter that is about to serve the request. Nothing is
 * persisted either: the loader's write-back hook honours `noSave`, so the
 * profile's own patch file keeps whatever it declared.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @returns {Promise<'declared' | 'claimed' | 'absent' | 'unusable' | 'failed'>}
 *   what was found and, when a route was missing, what came of re-adding it.
 */
async function claimRelayRoute(ctx) {
  const loader = ctx.get('loader')
  if (loader === undefined) return 'absent'
  const entry = [...loader.entries()].find(
    (row) => row.options.id === PI_AI_ENTRY.id && row.options.name === PI_AI_ENTRY.name,
  )
  if (entry === undefined) return 'absent'
  const state = relayRouteState(entry.options.config)
  if (state !== 'missing') return state
  const current = entry.options.config
  // `providers` may be absent rather than empty (see {@link relayRouteState}),
  // in which case this bundle's route is the first one the entry will serve.
  const providers = typeof current.providers === 'object' && current.providers !== null ? current.providers : {}
  try {
    await entry.update({
      config: {
        ...current,
        providers: { ...providers, [AGENTROUTER_PROVIDER]: structuredClone(AGENTROUTER_ROUTE) },
      },
    })
  } catch {
    // A profile that replaced the providers dict is also free to have made the
    // entry unconfigurable; that is its call, and the missing route is then the
    // reported symptom rather than a failure to hide.
    return 'failed'
  }
  return 'claimed'
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

    // The direct transport only exists to escape a proxy dispatcher, so it
    // activates when the launch environment names one and the destination
    // endpoint is covered by the bypass.
    const endpointKey = endpointKeyByHost(config).get(destination.toLowerCase())
    const direct =
      endpointKey !== undefined && bypassCovers(config.directEndpoints, endpointKey) && proxyEnvPresent()
        ? directFetch
        : undefined

    // The one body rewrite: the relay load-balances one model across several
    // upstream pools, and most of them validate tool schemas against a
    // meta-schema in which `required` must be an explicit array — an object
    // schema without one is rejected, for empty-parameter tools as the
    // confusing `null is not of type "array"`, and elsewhere as a bare
    // «Upstream rejected the request as invalid». Filling `required: []`
    // (semantically identical to omitting it) makes the request pass every
    // pool. Only a string `init.body` is rewritten; a streamed `Request` body
    // cannot be read without consuming it and goes out untouched.
    const rewritten = typeof init?.body === 'string' ? relayToolSchemaPatch(init.body) : undefined
    /** The caller's init with the patched body, when the patch produced one. */
    const withPatchedBody = (base) => (rewritten === undefined ? base : { ...base, body: rewritten })

    // Same host means the sentinel was not involved: rewrite the header only,
    // and leave the caller's own URL object or Request identity alone.
    //
    // `dispatch` is a function rather than a value because silent retry
    // re-invokes it: each call rebuilds the request from the parts the caller
    // supplied, so every attempt puts the identical bytes on the wire — which is
    // the point, since the failure belongs to the channel that drew the request,
    // not to the request.
    const dispatch = () => {
      if (destination.toLowerCase() === url.host.toLowerCase()) {
        if (direct !== undefined) return direct(url, withPatchedBody(unifiedInit(input, init, isRequest, headers)))
        if (isRequest && init === undefined) return native(new Request(input, { headers, duplex: 'half' }))
        return native(input, withPatchedBody({ ...init, headers }))
      }
      const target = new URL(url)
      target.host = destination
      if (direct !== undefined) return direct(target, withPatchedBody(unifiedInit(input, init, isRequest, headers)))
      if (isRequest)
        return native(
          new Request(target, withPatchedBody({ ...(init ?? {}), ...requestInitOf(input), headers, duplex: 'half' })),
        )
      return native(target, withPatchedBody({ ...init, headers }))
    }

    const signal = init?.signal ?? (isRequest ? input.signal : undefined)
    // `silentRetry` is volatile, so it arrives as a reference cell rather than a
    // boolean — a settings write mutates the cell in place instead of reloading
    // the fiber, and the next request must observe the new choice.
    const silentRetry = resolveVolatile(config.silentRetry) === true
    const pending =
      silentRetry && signal?.aborted !== true
        ? retryTransient(dispatch(), dispatch, resolveVolatile(config.silentRetryAttempts), signal, (attempt) =>
            console.log(`llm-agentrouter: relay rejected the request as a transient upstream error; re-sending (attempt ${attempt})`),
          )
        : dispatch()

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
 * Install the relay fence. The endpoint choice is a settings section.
 *
 * 0.1.2-0.1.5 registered that section by hand (`settings.installSection`,
 * removed upstream in 0.1.7); since 0.1.7 every activated entry's Config is
 * reflected into the settings plane automatically, and a settings write
 * updates the entry config, which reloads this fiber and re-runs `apply` —
 * so the fence always closes over the config it was started with.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin's context.
 * @param {ReturnType<typeof Config>} config - resolved entry configuration.
 */
function apply(ctx, config) {
  // The route claim has to happen on every activation, not just a first one: a
  // profile edit that adds a provider of its own reloads this fiber, and the
  // route is missing again by the time it does. `ctx.inject` waits for the
  // loader rather than declaring it a hard dependency, so a host that mounts
  // this plugin without one still gets the fence.
  if (config.claimRoute && typeof ctx.inject === 'function') {
    ctx.inject(['loader'], (scoped) => {
      scoped.effect(() => {
        let cancelled = false
        claimRelayRoute(scoped).then(
          (outcome) => {
            if (cancelled) return
            if (outcome === 'claimed') {
              console.log(
                `llm-agentrouter: the profile patch layer replaced llm-pi-ai.providers, dropping the ${AGENTROUTER_PROVIDER} route; re-declared it`,
              )
            } else if (outcome === 'failed') {
              ctx.logger.warn(
                `llm-agentrouter: the profile patch layer dropped the ${AGENTROUTER_PROVIDER} route and it could not be re-declared; every ${AGENTROUTER_PROVIDER} call will fail NO_ADAPTER`,
              )
            }
          },
          (error) => ctx.logger.warn('llm-agentrouter: route claim failed', error),
        )
        return () => {
          cancelled = true
        }
      })
    })
  }

  ctx.effect(() => {
    const previous = globalThis.fetch
    if (typeof previous !== 'function') {
      ctx.logger.warn('llm-agentrouter: no global fetch to fence; relay requests will be unroutable and rejected')
      return () => {}
    }
    const fenced = fenceFetch(previous, () => config)
    globalThis.fetch = fenced
    return () => {
      // Restore only what this plugin installed: a later wrapper layered on top
      // owns the global now, and clobbering it would drop that one's rewrite.
      if (globalThis.fetch === fenced) globalThis.fetch = previous
    }
  })

  if (config.announce) {
    const table = routingTable(config)
    const selected = resolveVolatile(config.endpoint)
    const direct = proxyEnvPresent() && bypassCovers(config.directEndpoints, selected)
    // console.log keeps the announcement visible like the official dsh web: URL
    // line (cordis loggers may be routed away from the terminal in this host).
    console.log(
      `llm-agentrouter: endpoint ${selected} (${table.get(config.sentinel.trim().toLowerCase()) ?? 'unrouted'}), sending ${config.userAgent}${direct ? ', direct (bypassing the process proxy)' : ''}`,
    )
  }
}

export { AGENTROUTER_SETTINGS_NAMESPACE, Config, apply, claimRelayRoute, name, relayToolSchemaPatch }
