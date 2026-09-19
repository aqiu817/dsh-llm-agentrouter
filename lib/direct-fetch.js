import http from 'node:http'
import https from 'node:https'
import { Readable } from 'node:stream'

/**
 * Direct transport for relay requests, used to bypass a process-level proxy.
 *
 * The relay's Cloudflare WAF challenges requests arriving from datacenter
 * egress IPs — exactly what an HTTPS_PROXY hop produces — with a 200 HTML
 * interstitial instead of the SSE stream, which a provider SDK surfaces as an
 * opaque transport failure. A direct connection from a residential network
 * passes. dsh installs its proxy dispatcher from the launch environment before
 * plugins load, so the fence cannot re-route through configuration; it has to
 * own the transport for these requests.
 *
 * Why not undici's `init.dispatcher`: a dispatcher only interoperates with the
 * undici copy the running Node bundles — an npm-installed Agent from a
 * different major fails inside the built-in fetch with an internal handler
 * assertion. `node:http`/`node:https` have no such coupling.
 *
 * The bridge follows fetch's shape for everything the provider SDKs rely on:
 * streaming request and response bodies, abort signals, and status/header
 * fidelity. It does not follow redirects (the relay's API contract has none)
 * and always answers with identity encoding, since it performs no
 * decompression.
 */

/** Statuses whose Response must carry no body. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])

/** Shared agents so relay requests reuse pooled sockets like fetch does. */
const agents = {
  'http:': new http.Agent({ keepAlive: true }),
  'https:': new https.Agent({ keepAlive: true }),
}

/**
 * Whether the launch environment names any proxy this process would honour.
 *
 * dsh installs its dispatcher from exactly these variables, so their presence
 * is what makes a direct transport meaningful; without them the bridge and the
 * regular fetch would behave identically and the fence keeps the native path.
 *
 * @param {typeof process.env} [env] - the environment to inspect.
 * @returns {boolean} true when any proxy variable is set to a non-blank value.
 */
export function proxyEnvPresent(env = process.env) {
  for (const name of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const value = env[name]
    if (typeof value === 'string' && value.trim() !== '') return true
  }
  return false
}

/**
 * Send one request over a direct `node:http`/`node:https` connection.
 *
 * @param {URL | string} input - the absolute URL to request.
 * @param {RequestInit} [init] - method, headers, body, and signal. Recognised
 *   body shapes: string, ArrayBuffer/TypedArray, URLSearchParams, and
 *   ReadableStream (streamed as chunked upload). Unknown init fields are
 *   ignored.
 * @returns {Promise<Response>} the response, with a streaming body.
 */
export function directFetch(input, init = {}) {
  const url = typeof input === 'string' ? new URL(input) : input
  if (!(url instanceof URL) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return Promise.reject(new TypeError(`fetch failed (direct transport: unsupported URL ${String(input)})`))
  }

  const headers = new Headers(init.headers ?? undefined)
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity')
  const headerBag = {}
  for (const [name, value] of headers.entries()) headerBag[name] = value

  const method = (init.method ?? 'GET').toUpperCase()
  const hasBody = method !== 'GET' && method !== 'HEAD' && init.body !== undefined && init.body !== null
  const streamBody = hasBody && typeof ReadableStream === 'function' && init.body instanceof ReadableStream
  const payload = !hasBody
    ? null
    : streamBody
      ? null
      : typeof init.body === 'string'
        ? Buffer.from(init.body, 'utf8')
        : init.body instanceof URLSearchParams
          ? Buffer.from(init.body.toString(), 'utf8')
          : ArrayBuffer.isView(init.body) || init.body instanceof ArrayBuffer
            ? Buffer.from(init.body)
            : null
  if (payload !== null && !headers.has('content-length')) headerBag['content-length'] = String(payload.length)

  const signal = init.signal ?? undefined

  return new Promise((resolve, reject) => {
    let currentResponse = null
    let settled = false

    // The abort listener must outlive the response headers: a turn cancelled
    // mid-stream has to cut the connection, not keep draining the relay.
    function settle() {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
    }
    function onAbort() {
      request.destroy()
      currentResponse?.destroy()
    }
    function failure(cause) {
      settle()
      reject(
        signal?.aborted
          ? new DOMException('This operation was aborted', 'AbortError')
          : new TypeError('fetch failed', { cause }),
      )
    }

    const transport = url.protocol === 'http:' ? http : https
    const request = transport.request(url, { method, headers: headerBag, agent: agents[url.protocol] }, (response) => {
      currentResponse = response
      response.on('close', settle)
      const responseHeaders = new Headers()
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        responseHeaders.append(response.rawHeaders[i], response.rawHeaders[i + 1])
      }
      const status = response.statusCode ?? 590
      const bodyInit = NULL_BODY_STATUS.has(status) || method === 'HEAD' ? null : Readable.toWeb(response)
      resolve(new Response(bodyInit, { status, statusText: response.statusMessage ?? '', headers: responseHeaders }))
    })

    request.on('error', failure)
    if (signal !== undefined) {
      if (signal.aborted) {
        failure(new DOMException('This operation was aborted', 'AbortError'))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    if (payload !== null) request.end(payload)
    else if (streamBody) {
      const source = Readable.fromWeb(init.body)
      source.on('error', (cause) => request.destroy(cause))
      source.pipe(request)
    } else request.end()
  })
}
