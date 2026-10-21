// Shape gate for magpie-grok-bot. Loads index.mjs exactly as the host does and
// checks what the plugin function returns: the assertions the community gate
// enforces (auth.provider, auth.loader, non-empty auth.methods with authorize on
// every oauth entry, config producing npm + non-empty models) plus the expected
// provider id, display name and static model, and the no-helper-export rule (an
// exported helper is invoked as a plugin and its throw poisons the load —
// internals hang off `_internal`).
//
// With --stubs, every child-process, fetch and WebSocket entry point is replaced
// by a sentinel and the provider is driven with an isolated app fixture: its
// sign-in reports the missing install, and its transport answers with the same
// 502 without touching the app. It signs in to nothing and sends no request.

import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const EXPECTED = {
  GrokBotPlugin: {
    id: "grok-bot",
    name: "Grok Bot (xAI desktop)",
    models: { "app-bot": "App bot (the currently selected bot)" },
  },
}

const root = fileURLToPath(new URL("..", import.meta.url))
const problems = []
let sandboxOperations = 0
if (process.argv.includes("--stubs")) {
  const forbidden = () => { sandboxOperations++; throw new Error("sandbox gate attempted external access") }
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) childProcess[key] = forbidden
  syncBuiltinESMExports()
  globalThis.fetch = forbidden
  globalThis.WebSocket = class { constructor() { forbidden() } }
  if (globalThis.Bun) { Bun.spawn = forbidden; Bun.spawnSync = forbidden }
}

const mod = await import(pathToFileURL(join(root, "index.mjs")).href)

for (const key of Object.keys(EXPECTED))
  if (typeof mod[key] !== "function") problems.push(`missing plugin function export: ${key}`)
for (const key of Object.keys(mod)) {
  if (key === "_internal") {
    if (typeof mod._internal === "function") problems.push("_internal is a function — exported helpers are invoked as plugins")
    continue
  }
  if (!(key in EXPECTED)) problems.push(`unexpected export: ${key} (every exported function is invoked as a plugin — helpers belong under _internal)`)
}

const ids = []
const client = {
  app: { log: async () => {} },
  auth: { set: async () => {} },
  tui: { showToast: async () => {} },
  config: { get: async () => ({ data: {} }) },
}

async function isolatedGrokBot() {
  const { makeGrokBotDriver } = await import(pathToFileURL(join(root, "providers/grok-bot.mjs")).href)
  const { CDP_ERRORS } = await import(pathToFileURL(join(root, "providers/grok-bot-cdp.mjs")).href)
  let operations = 0
  const forbidden = () => { operations++; throw new Error("implemented gate attempted app access") }
  const isolated = makeGrokBotDriver({}, { grokBot: { persistSessions: false } }, {
    cdp: { env: {}, exists: async () => false, readFile: forbidden, execFile: forbidden, processes: forbidden, spawn: forbidden, fetch: forbidden, freePort: forbidden, connect: forbidden },
    importDirect: async () => { throw new Error("fixture missing direct module") },
  })
  for (const method of isolated.auth.methods) {
    const shape = await method.authorize({ env: "sandbox" })
    if (shape.method !== "auto" || typeof shape.callback !== "function") throw new Error("malformed OAuth flow")
  }
  const flow = await isolated.auth.methods[0].authorize()
  const result = await flow.callback()
  if (result.type !== "failed" || result.error !== CDP_ERRORS.missing) throw new Error("implemented missing-install contract failed")
  if (Object.keys(await isolated.auth.loader(async () => null)).length) throw new Error("signed-out loader is active")
  const loader = await isolated.auth.loader(async () => ({ type: "oauth", access: "app-local", mechanism: "cdp" }))
  const response = await loader.fetch(loader.baseURL + "/chat/completions", { method: "POST", body: JSON.stringify({ model: "app-bot", messages: [{ role: "user", content: "gate" }] }) })
  if (response.status !== 502 || response.headers.get("X-Magpie-Sign-In") !== "kept" || (await response.json()).error.message !== result.error) throw new Error("implemented transport error contract failed")
  if ((await (await isolated.auth.methods[1].authorize()).callback()).type !== "failed" || operations !== 0) throw new Error("implemented transport isolation failed")
  console.log("implemented: grok-bot; app operations: 0")
}

for (const [fnName, fn] of Object.entries(mod)) {
  if (typeof fn !== "function") continue
  const want = EXPECTED[fnName]
  try {
    const hooks = await fn({ client, directory: process.cwd(), worktree: process.cwd(), $: undefined, project: {} })
    const auth = hooks?.auth
    if (!auth) {
      problems.push(`${fnName}: no auth hook`)
      continue
    }
    if (typeof auth.provider !== "string" || !auth.provider) problems.push(`${fnName}: auth.provider`)
    else if (want && auth.provider !== want.id) problems.push(`${fnName}: auth.provider is ${auth.provider}, expected ${want.id}`)
    else ids.push(auth.provider)
    if (typeof auth.loader !== "function") problems.push(`${fnName}: auth.loader`)
    if (!Array.isArray(auth.methods) || !auth.methods.length) problems.push(`${fnName}: auth.methods`)
    for (const m of auth.methods ?? []) {
      if (!["oauth", "api"].includes(m.type)) problems.push(`${fnName}: method type ${m.type}`)
      if (m.type === "oauth" && typeof m.authorize !== "function") problems.push(`${fnName}: ${m.label} has no authorize`)
    }
    if (process.argv.includes("--stubs") && auth.provider === "grok-bot") await isolatedGrokBot()
    if (!hooks.config) {
      problems.push(`${fnName}: no config hook`)
      continue
    }
    const cfg = { provider: {} }
    await hooks.config(cfg)
    const p = cfg.provider[auth.provider]
    if (!p) problems.push(`${fnName}: config adds no ${auth.provider} provider`)
    else {
      if (!p.npm) problems.push(`${fnName}: config gives ${auth.provider} no npm`)
      if (want && p.name !== want.name) problems.push(`${fnName}: display name ${p.name}, expected ${want.name}`)
      if (!p.models || !Object.keys(p.models).length) problems.push(`${fnName}: config gives ${auth.provider} no models`)
      else if (want)
        for (const [modelId, modelName] of Object.entries(want.models)) {
          const m = p.models[modelId]
          if (!m) problems.push(`${fnName}: ${auth.provider} is missing model ${modelId}`)
          else {
            if (m.name !== modelName) problems.push(`${fnName}: model ${modelId} is named ${m.name}, expected ${modelName}`)
            if (m.tool_call !== false) problems.push(`${fnName}: model ${modelId} must declare tool_call: false (prose answers only)`)
          }
        }
    }
  } catch (e) {
    problems.push(`${fnName}: ${e?.stack ?? e}`)
  }
}

const missingIds = Object.values(EXPECTED).map(w => w.id).filter(id => !ids.includes(id))
if (missingIds.length) problems.push(`provider ids missing: ${missingIds.join(", ")}`)
if (process.argv.includes("--stubs")) console.log(`sandbox summary: external operations: ${sandboxOperations}`)
if (sandboxOperations) problems.push(`sandbox isolation failed: ${sandboxOperations} external operations`)
if (problems.length) {
  console.error(`✗ magpie-grok-bot\n  ${problems.join("\n  ")}`)
  process.exit(1)
}
console.log(`✓ magpie-grok-bot (${ids.length} provider: ${ids.join(", ")})`)
