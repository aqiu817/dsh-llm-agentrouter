// Generates lib/route.js from cordis.patch.yml so the runtime route value and
// the declared patch cannot drift. Run with `npm run gen-route`.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const patchPath = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const routePath = fileURLToPath(new URL('../lib/route.js', import.meta.url))
const rows = yaml.load(fs.readFileSync(patchPath, 'utf8'))
const pi = rows.find((row) => row.id === 'llm-pi-ai')
if (pi === undefined) throw new Error('cordis.patch.yml declares no llm-pi-ai patch')
const route = pi.config.providers.agentrouter
if (route === undefined) throw new Error('cordis.patch.yml declares no agentrouter route')

const text = `/**
 * The AgentRouter route as a runtime value.
 *
 * This is the route \`cordis.patch.yml\` declares, in the form the plugin needs
 * to *re-add* at runtime. It exists because a profile's own
 * \`llm-pi-ai.providers\` patch is applied after every bundle layer, and the
 * loader's patch merge assigns a patch's \`config\` over the composed one — one
 * level deep, so the whole \`providers\` dict is replaced rather than merged.
 * A profile that declares any provider of its own therefore drops the
 * \`agentrouter\` route: the shipped \`desktop\` profile does exactly that, and so
 * does any profile with a second relay.
 *
 * The fence re-installs the route through the entry's own volatile config, which
 * the adapter observes on the next request. \`test/route-parity.test.mjs\` asserts
 * this value still equals the patch's, so the two cannot drift apart.
 *
 * @module dsh-llm-agentrouter/route
 */

/** The provider key this bundle owns inside \`llm-pi-ai.providers\`. */
const AGENTROUTER_PROVIDER = 'agentrouter'

/** The loader entry id and name the route is declared on. */
const PI_AI_ENTRY = { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' }

/** The route exactly as \`cordis.patch.yml\` declares it. */
const AGENTROUTER_ROUTE = ${JSON.stringify(route, null, 2)}

export { AGENTROUTER_PROVIDER, AGENTROUTER_ROUTE, PI_AI_ENTRY }
`
fs.writeFileSync(routePath, text)
console.log('lib/route.js written:', fs.statSync(routePath).size, 'bytes')
