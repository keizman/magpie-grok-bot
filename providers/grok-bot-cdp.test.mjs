import { afterEach, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { makeGrokBotDriver } from "./grok-bot.mjs"
import { BINDING, CDP_ERRORS, LAUNCH_FLAGS, createGrokBotCdp, findGrokBot } from "./grok-bot-cdp.mjs"
import { SESSION_HEADER } from "../lib/sessions.mjs"
import { createConversationStore } from "../lib/conversations.mjs"

const MARKER = /\[magpie [0-9a-f]{8}\.\d+\.[0-9a-f]{6}\]/g
const PLIST = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Grok Bot</string></dict></plist>`
const BUNDLE = "/Applications/Grok Bot.app"
const EXECUTABLE = `${BUNDLE}/Contents/MacOS/Grok Bot`
const cleanup = []
afterEach(async () => { for (const job of cleanup.splice(0)) await job() })

// An in-memory stand-in for the Grok Bot page: per-bot chats, a composer, and the bridge calls the driver makes.
function fakeApp(settings = {}) {
  const state = {
    signedIn: true, binding: true, selected: "bot-a", draft: "", sent: [], spawns: [], focusCount: 0,
    bots: [{ id: "bot-a", name: "Alpha" }, { id: "bot-b", name: "Beta" }],
    chats: { "bot-a": [], "bot-b": [] }, watch: null, done: false,
    reply: () => ["ok"], replyMs: 15,
    ...settings,
  }
  const listeners = new Map()
  let PAGE
  function read(target) {
    const rows = state.chats[state.selected] ?? []
    const norm = value => String(value ?? "").replace(/\s+/g, " ").trim()
    let mine = -1
    if (typeof target === "string") rows.forEach((row, index) => { if (row.role === "user" && target && row.text.includes(target)) mine = index })
    else if (target) {
      const users = rows.map((row, index) => index).filter(index => rows[index].role === "user" && index >= (target.from ?? 0))
      const exact = users.filter(index => norm(rows[index].text).includes(norm(target.text)))
      mine = (target.last ? exact.at(-1) : exact[0] ?? (target.loose ? users.at(-1) : undefined)) ?? -1
    }
    const out = { selected: state.selected, found: mine >= 0, at: mine >= 0 ? mine : null, next: rows.length, markers: rows.filter(row => row.role === "user").map(row => row.text).join("\n").match(MARKER) ?? [], texts: [], streaming: false, working: false, failed: false, after: 0, userAfter: false }
    if (mine < 0) return out
    for (const row of rows.slice(mine + 1)) {
      if (row.role === "user") { out.userAfter = true; break }
      out.after++
      if (row.working) out.working = true
      if (row.streaming) out.streaming = true
      if (row.text) out.texts.push(row.text)
    }
    return out
  }
  function emit() {
    if (!state.watch || !state.binding) return
    const payload = JSON.stringify({ id: state.watch.id, snapshot: read(state.watch.marker) })
    for (const listener of listeners.get("Runtime.bindingCalled") ?? []) listener({ name: BINDING, payload })
  }
  async function answer(bot, prompt) {
    const rows = state.chats[bot]
    const row = { role: "bot", text: "", streaming: true, working: true }
    const parts = state.reply(prompt, state)
    state.done = false
    await Bun.sleep(state.replyMs)
    rows.push(row); emit()
    for (const part of parts) {
      await Bun.sleep(state.replyMs)
      row.text += part
      emit()
    }
    await Bun.sleep(state.replyMs)
    row.streaming = false; row.working = false
    state.done = true
    emit()
  }
  function submit() {
    if (!state.draft) return
    const text = state.draft
    state.draft = ""
    state.chats[state.selected].push({ role: "user", text })
    state.sent.push({ bot: state.selected, text })
    emit()
    void answer(state.selected, text)
  }
  function page(call) {
    const match = call.match(/^(\w+)\(([^]*)\)( !== null)?$/)
    const [, name, raw, notNull] = match
    const args = JSON.parse(`[${raw}]`)
    if (notNull) return true
    switch (name) {
      case "bots": return state.bots.map(bot => ({ ...bot, selected: bot.id === state.selected }))
      case "selected": return state.selected
      case "select": {
        if (!state.bots.some(bot => bot.id === args[0])) return { ok: false }
        if (state.selected === args[0]) return { ok: true, selected: true }
        if (args[1]) state.selected = args[0]
        return { ok: true, selected: false }
      }
      case "focus": state.focusCount++; return { ok: true, text: state.draft }
      case "draft": return state.draft
      case "read": return read(args[0])
      case "watch": state.watch = { id: args[0], marker: args[1] }; return true
      case "unwatch": state.watch = null; return true
      case "signedOut": return false
      default: throw new Error(`unexpected page call ${name}`)
    }
  }
  function evaluate(expression) {
    if (expression.includes("getCursorAuthStatus")) return state.signedIn
    if (expression.includes("getHostPinnedAgents")) return [{ pinnedAgentIds: state.bots.map(bot => bot.id) }, null, { agents: state.bots.map(bot => ({ agentId: bot.id, name: bot.name })) }, null]
    if (expression.includes("bridge not ready")) return true
    PAGE ??= createGrokBotCdp({})._test.PAGE
    if (expression.startsWith(`(${PAGE})(`)) {
      const rest = expression.slice(PAGE.length + 3)
      return page(rest.slice(rest.indexOf("}).") + 3))
    }
    throw new Error("unexpected expression")
  }
  const calls = []
  const client = {
    open: true,
    async call(method, params = {}) {
      calls.push({ method, params })
      if (!this.open) throw Object.assign(new Error("closed"), { status: 502 })
      if (method === "Runtime.evaluate") return { result: { value: evaluate(params.expression) } }
      if (method === "Runtime.addBinding" && !state.binding) throw Object.assign(new Error("no bindings"), { bridge: true })
      if (method === "Input.insertText") state.draft = params.text
      if (method === "Input.dispatchKeyEvent" && params.type === "keyDown" && params.key === "Enter") submit()
      return {}
    },
    async evaluate(expression) { return (await this.call("Runtime.evaluate", { expression }))?.result?.value },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(listener)
      return () => listeners.get(method)?.delete(listener)
    },
    close() { this.open = false },
  }
  const dependencies = {
    platform: "darwin", env: { HOME: "/Users/tester" }, host: new EventEmitter(),
    exists: async path => [BUNDLE, EXECUTABLE].includes(path),
    readFile: async () => PLIST,
    processes: async () => (state.processes ?? []).map(row => ({ ...row })), parentAlive: () => true, stopManaged: async () => {}, stopManagedSync() {},
    stopApp: async row => { (state.stopped ??= []).push(row.pid); state.processes = (state.processes ?? []).filter(current => current.pid !== row.pid || state.stubborn) },
    freePort: async () => 9444,
    spawn(executable, argv, spawnOptions) { state.spawns.push({ executable, argv, options: spawnOptions }); return { pid: 900, exitCode: null, once() {}, unref() { state.unref = true } } },
    fetch: async url => Response.json(String(url).endsWith("/json/version") ? { "User-Agent": "Mozilla/5.0 GrokBot/0.72.1 Chrome/146 Electron/41" } : [{ type: "page", url: "file:///Applications/Grok%20Bot.app/Contents/Resources/app.asar/dist/renderer/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9444/devtools/page/1" }]),
    connect: async () => client,
  }
  return { state, client, calls, dependencies, emit }
}

function harness(settings = {}, options = {}) {
  const app = fakeApp(settings)
  const dir = mkdtempSync(join(tmpdir(), "grok-cdp-test-"))
  const grokBot = { settleMs: 40, streamPollMs: 10, botsMs: 0, stateDir: dir, ...options }
  const make = (overrides = {}) => {
    const plugin = makeGrokBotDriver({}, { grokBot: { ...grokBot, ...overrides } }, { cdp: app.dependencies })
    return plugin
  }
  const plugins = [make()]
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return {
    app, dir, plugin: plugins[0],
    restart(overrides) { const plugin = make(overrides); plugins.push(plugin); return plugin },
  }
}
const auth = { type: "oauth", access: "app-local", mechanism: "cdp", accountId: "grok-bot-cdp" }
async function fetcherOf(plugin) { return (await plugin.auth.loader(async () => auth)).fetch }

async function chat(plugin, messages, { session = "session-1", stream = true, model = "app-bot", onChunk } = {}) {
  const fetch = await fetcherOf(plugin)
  const headers = session ? { [SESSION_HEADER]: session } : {}
  const response = await fetch("https://grok-bot.cloud-agents.invalid/v1/chat/completions", { method: "POST", headers, body: JSON.stringify({ model, stream, messages }) })
  if (!stream) return { response, json: await response.json() }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events = []
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      if (!line.startsWith("data: ")) continue
      const data = line.slice(6)
      const event = data === "[DONE]" ? { done: true } : JSON.parse(data)
      events.push(event)
      onChunk?.(event)
    }
  }
  const content = events.flatMap(event => event.choices?.[0]?.delta?.content ? [event.choices[0].delta.content] : [])
  const error = events.find(event => event.error)
  return { events, content, text: content.join(""), error }
}
const user = content => ({ role: "user", content })
const bot = content => ({ role: "assistant", content })

test("finds the app bundle on macOS through Info.plist", async () => {
  const app = fakeApp()
  expect(await findGrokBot(app.dependencies)).toBe(EXECUTABLE)
  let error
  try { await findGrokBot({ ...app.dependencies, exists: async () => false }) } catch (caught) { error = caught }
  expect(error.message).toBe(CDP_ERRORS.missing)
  expect(error.status).toBe(502)
})

test("by default launches the installed app with its own signed-in profile, detached and unowned", async () => {
  const { app, plugin } = harness()
  const result = await chat(plugin, [user("hello")])
  expect(result.error).toBeUndefined()
  const [spawned] = app.state.spawns
  expect(spawned.executable).toBe(EXECUTABLE)
  expect(spawned.argv).toContain("--remote-debugging-address=127.0.0.1")
  expect(spawned.argv.some(arg => arg.startsWith("--user-data-dir="))).toBe(false)
  expect(spawned.argv.some(arg => arg.startsWith("--magpie-grok-managed="))).toBe(false)
  expect(spawned.options.detached).toBe(true)
  expect(app.state.unref).toBe(true)
  for (const flag of LAUNCH_FLAGS) expect(spawned.argv).toContain(flag)
})

test("profile \"managed\" launches a separate profile under Application Support", async () => {
  const { app, plugin } = harness({}, { profile: "managed" })
  await chat(plugin, [user("hello")])
  const [spawned] = app.state.spawns
  expect(spawned.argv).toContain("--user-data-dir=/Users/tester/Library/Application Support/Magpie/grok-bot-managed-profile")
  expect(spawned.argv.some(arg => arg.startsWith("--magpie-grok-managed="))).toBe(true)
})

const running = (pid, command) => ({ pid, created: "Tue Oct 21 07:46:00 2026", executable: EXECUTABLE, command, port: Number(command.match(/--remote-debugging-port=(\d+)/)?.[1]) || undefined })

test("attaches to the user's app when it already has a debug port, ignoring Magpie's managed window", async () => {
  const { app, plugin } = harness({ processes: [
    running(1, `${EXECUTABLE} --remote-debugging-port=9555 --user-data-dir=/Users/tester/Library/Application Support/Magpie/grok-bot-managed-profile`),
    running(2, `${EXECUTABLE} --remote-debugging-port=9444`),
  ] })
  const ports = []
  const fetch = app.dependencies.fetch
  app.dependencies.fetch = async (url, init) => { ports.push(new URL(url).port); return fetch(url, init) }
  const result = await chat(plugin, [user("hello")])
  expect(result.error).toBeUndefined()
  expect(app.state.spawns).toHaveLength(0)
  expect(ports).not.toContain("9555")
  expect(app.state.stopped).toBeUndefined()
})

test("quits a running app that lacks a debug port and reopens it with one", async () => {
  const { app, plugin } = harness({ processes: [running(7, EXECUTABLE)] }, { relaunchDelayMs: 0 })
  const result = await chat(plugin, [user("hello")])
  expect(result.error).toBeUndefined()
  expect(app.state.stopped).toEqual([7])
  expect(app.state.spawns).toHaveLength(1)
})

test("the first bot list on a new connection waits for a freshly booted sidebar to fill in", async () => {
  const all = [{ id: "bot-a", name: "Alpha" }, { id: "bot-b", name: "Beta" }, { id: "bot-c", name: "Gamma" }]
  const { app, plugin } = harness({ bots: all.slice(0, 1), selected: null }, { botsMs: 3000 })
  setTimeout(() => { app.state.bots = all; app.state.selected = "bot-b" }, 500)
  const config = {}
  await plugin.config(config)
  const models = await plugin.provider.models(config.provider["grok-bot"], { auth })
  expect(Object.keys(models).filter(id => id !== "app-bot").sort()).toEqual(["bot-a", "bot-b", "bot-c"])
})

test("restartApp false refuses to quit the user's app", async () => {
  const { app, plugin } = harness({ processes: [running(7, EXECUTABLE)] }, { restartApp: false })
  const { response } = await chat(plugin, [user("hello")], { stream: false })
  expect(response.status).toBe(409)
  expect(app.state.stopped).toBeUndefined()
  expect(app.state.spawns).toHaveLength(0)
})

test("an app that won't quit reports how to quit it instead of launching a second copy", async () => {
  const { app, plugin } = harness({ processes: [running(7, EXECUTABLE)], stubborn: true }, { quitTimeoutMs: 0 })
  const { response, json } = await chat(plugin, [user("hello")], { stream: false })
  expect(response.status).toBe(409)
  expect(JSON.stringify(json)).toContain("didn't quit in time")
  expect(app.state.spawns).toHaveLength(0)
})

test("reply content streams as ordered deltas while the bot is still writing", async () => {
  const { app, plugin } = harness({ reply: () => ["The ", "quick ", "brown ", "fox ", "jumps."] })
  const early = []
  const result = await chat(plugin, [user("tell me something")], { onChunk: event => { if (event.choices?.[0]?.delta?.content && !app.state.done) early.push(event.choices[0].delta.content) } })
  expect(result.error).toBeUndefined()
  expect(result.text).toBe("The quick brown fox jumps.")
  expect(result.content.length).toBeGreaterThanOrEqual(4)
  expect(early.length).toBeGreaterThanOrEqual(3)
  expect("The quick brown fox jumps.".startsWith(early.join(""))).toBe(true)
  expect(result.events.at(-1)).toEqual({ done: true })
  expect(result.events.at(-2).choices[0].finish_reason).toBe("stop")
  expect(app.client.on).toBeDefined()
  expect(app.calls.some(call => call.method === "Runtime.addBinding" && call.params.name === BINDING)).toBe(true)
})

test("without bindings the driver polls the page and still streams", async () => {
  const { app, plugin } = harness({ binding: false, reply: () => ["one ", "two ", "three"], replyMs: 30 })
  const result = await chat(plugin, [user("count")])
  expect(result.text).toBe("one two three")
  expect(result.content.length).toBeGreaterThanOrEqual(2)
  expect(app.state.watch).toBeNull()
})

test("non-streaming requests get the whole reply", async () => {
  const { plugin } = harness({ reply: () => ["full ", "answer"] })
  const { response, json } = await chat(plugin, [user("hi")], { stream: false })
  expect(response.status).toBe(200)
  expect(json.choices[0].message.content).toBe("full answer")
})

test("one magpie conversation maps to one tagged segment and only new turns are sent", async () => {
  const { app, plugin } = harness({ reply: prompt => [/4721/.test(prompt) && !/what number/.test(prompt) ? "Noted." : /what number/.test(prompt) ? "You asked me to remember 4721." : "ok"] })
  const system = { role: "system", content: "You are helpful." }
  const first = await chat(plugin, [system, user("remember the number 4721")])
  expect(first.text).toBe("Noted.")
  const second = await chat(plugin, [system, user("remember the number 4721"), bot("Noted."), user("what number did I ask you to remember?")])
  expect(second.text).toContain("4721")
  expect(app.state.sent).toHaveLength(2)
  const [opening, followUp] = app.state.sent.map(row => row.text)
  expect(opening).toContain("New conversation")
  expect(opening).toContain("You are helpful.")
  expect(opening).toContain("remember the number 4721")
  expect(followUp.startsWith("what number did I ask you to remember?\n\n[magpie ")).toBe(true)
  expect(followUp).not.toContain("You are helpful.")
  expect(followUp).not.toContain("remember the number 4721")
  const tags = app.state.sent.map(row => row.text.match(/\[magpie ([0-9a-f]{8})\.(\d+)\./).slice(1))
  expect(tags[0][0]).toBe(tags[1][0])
  expect(tags.map(tag => tag[1])).toEqual(["0", "1"])
})

test("a retried turn reattaches to its reply instead of sending again", async () => {
  const { app, plugin } = harness({ reply: () => ["first reply"] })
  await chat(plugin, [user("hello")])
  const again = await chat(plugin, [user("hello")])
  expect(again.text).toBe("first reply")
  expect(app.state.sent).toHaveLength(1)
})

test("a new magpie session opens a new segment in the same bot chat", async () => {
  const { app, plugin } = harness()
  await chat(plugin, [user("hello")], { session: "session-a" })
  await chat(plugin, [user("hello")], { session: "session-b" })
  expect(app.state.sent).toHaveLength(2)
  const [a, b] = app.state.sent.map(row => row.text.match(/\[magpie ([0-9a-f]{8})/)[1])
  expect(a).not.toBe(b)
  expect(app.state.sent[1].text).toContain("New conversation")
})

test("an edited history folds the conversation once, then continues normally", async () => {
  const { app, plugin } = harness()
  await chat(plugin, [user("alpha"), bot("ok"), user("beta")].slice(0, 1))
  await chat(plugin, [user("alpha"), bot("ok"), user("beta")])
  await chat(plugin, [user("ALPHA edited"), bot("ok"), user("beta")])
  const branched = app.state.sent[2].text
  expect(branched).toContain("history you haven't seen")
  expect(branched).toContain("Conversation so far:")
  expect(branched).toContain("ALPHA edited")
  await chat(plugin, [user("ALPHA edited"), bot("ok"), user("beta"), bot("ok"), user("gamma")])
  expect(app.state.sent[3].text.startsWith("gamma\n\n[magpie ")).toBe(true)
})

test("history Grok Bot has never seen is sent once as a catch-up prompt", async () => {
  const { app, plugin } = harness()
  await chat(plugin, [user("earlier question"), bot("earlier answer"), user("new question")], { session: null })
  expect(app.state.sent).toHaveLength(1)
  expect(app.state.sent[0].text).toContain("Assistant: earlier answer")
  expect(app.state.sent[0].text).toContain("Current request:\nnew question")
  await chat(plugin, [user("earlier question"), bot("earlier answer"), user("new question"), bot("ok"), user("next")], { session: null })
  expect(app.state.sent[1].text.startsWith("next\n\n[magpie ")).toBe(true)
})

test("the mapping survives a restart through the persisted store", async () => {
  const { app, plugin, dir, restart } = harness()
  await chat(plugin, [user("remember 4721")])
  const file = join(dir, "conversations.json")
  expect(statSync(file).mode & 0o777).toBe(0o600)
  const second = restart()
  await chat(second, [user("remember 4721"), bot("ok"), user("which number?")])
  expect(app.state.sent).toHaveLength(2)
  expect(app.state.sent[1].text.startsWith("which number?\n\n[magpie ")).toBe(true)
})

test("without a stored record the chat's own markers recover the conversation", async () => {
  const { app, plugin, restart } = harness()
  await chat(plugin, [user("remember 4721")])
  const second = restart({ persistSessions: false, stateDir: mkdtempSync(join(tmpdir(), "grok-cdp-empty-")) })
  await chat(second, [user("remember 4721"), bot("ok"), user("which number?")])
  expect(app.state.sent[1].text.startsWith("which number?\n\n[magpie ")).toBe(true)
  expect(app.state.sent[1].text.match(/\[magpie ([0-9a-f]{8})/)[1]).toBe(app.state.sent[0].text.match(/\[magpie ([0-9a-f]{8})/)[1])
})

test("marker false sends prompts without the [magpie …] line and still streams each turn", async () => {
  let count = 0
  const { app, plugin } = harness({ reply: () => [`reply `, `${++count}`] }, { marker: false, sessionHeader: false })
  const first = await chat(plugin, [user("remember 4721")])
  const second = await chat(plugin, [user("remember 4721"), bot(first.text), user("which number?")])
  expect(first.text).toBe("reply 1")
  expect(second.text).toBe("reply 2")
  expect(second.content.length).toBeGreaterThan(1)
  expect(app.state.sent.map(row => row.text)).toEqual(["remember 4721", "which number?"])
})

test("marker false tells a repeated prompt apart by where it was sent", async () => {
  let count = 0
  const { app, plugin } = harness({ reply: () => [`part ${++count}`] }, { marker: false, sessionHeader: false })
  const history = [user("continue")]
  const first = await chat(plugin, history)
  const second = await chat(plugin, [...history, bot(first.text), user("continue")])
  expect(first.text).toBe("part 1")
  expect(second.text).toBe("part 2")
  expect(app.state.sent).toHaveLength(2)
})

test("marker false reattaches a retried turn without typing it twice", async () => {
  const { app, plugin } = harness({ reply: () => ["first reply"] }, { marker: false })
  await chat(plugin, [user("hello")])
  const again = await chat(plugin, [user("hello")])
  expect(again.text).toBe("first reply")
  expect(app.state.sent).toHaveLength(1)
})

test("marker false without a stored record falls back to a one-time catch-up", async () => {
  const { app, plugin, restart } = harness({}, { marker: false })
  await chat(plugin, [user("remember 4721")])
  const second = restart({ persistSessions: false, stateDir: mkdtempSync(join(tmpdir(), "grok-cdp-empty-")) })
  await chat(second, [user("remember 4721"), bot("ok"), user("which number?")])
  expect(app.state.sent[1].text).toContain("Current request:\nwhich number?")
  expect(app.state.sent[1].text).not.toMatch(MARKER)
})

test("a conversation stays pinned to its bot when the app selection changes", async () => {
  const { app, plugin } = harness()
  await chat(plugin, [user("hello")])
  app.state.selected = "bot-b"
  await chat(plugin, [user("hello"), bot("ok"), user("again")])
  expect(app.state.sent.map(row => row.bot)).toEqual(["bot-a", "bot-a"])
})

test("a named bot model sends to that bot", async () => {
  const { app, plugin } = harness()
  await chat(plugin, [user("hello")], { model: "bot-b" })
  expect(app.state.sent[0].bot).toBe("bot-b")
})

test("live models list the app's bots", async () => {
  const { plugin } = harness()
  const config = {}
  await plugin.config(config)
  const models = await plugin.provider.models(config.provider["grok-bot"], { auth })
  expect(Object.keys(models)).toEqual(["bot-a", "bot-b", "app-bot"])
  expect(models["bot-a"].name).toBe("Alpha")
})

test("a signed-out window reports a 401 that asks for sign-in", async () => {
  const { app, plugin } = harness({ signedIn: false })
  const result = await chat(plugin, [user("hello")], { stream: false })
  expect(result.response.status).toBe(401)
  expect(result.json.error.message).toContain(CDP_ERRORS.signedOut)
  expect(app.state.sent).toHaveLength(0)
})

test("a second request while a reply is running is refused with 409", async () => {
  const { plugin } = harness({ replyMs: 40 })
  const running = chat(plugin, [user("one")], { session: "a" })
  await Bun.sleep(30)
  const blocked = await chat(plugin, [user("two")], { session: "b", stream: false })
  expect(blocked.response.status).toBe(409)
  expect((await running).text).toBe("ok")
})

test("judge settles on stable text and waits while the bot is busy", () => {
  let clock = 0
  const driver = createGrokBotCdp({ settleMs: 100, stuckMs: 1000 }, { platform: "darwin", env: { HOME: "/h" }, timers: { now: () => clock, setTimeout, clearTimeout }, store: createConversationStore({ persist: false }) })
  const run = { bot: { id: "a", name: "A" }, lastText: "", changedAt: 0, busyAt: 0 }
  const snap = (texts, extra = {}) => ({ selected: "a", found: true, texts, after: 1, ...extra })
  expect(driver._test.judge(run, snap(["hi"], { streaming: true })).state).toBe("running")
  clock = 150
  expect(driver._test.judge(run, snap(["hi"], { streaming: true })).state).toBe("running")
  expect(driver._test.judge(run, snap(["hi"])).state).toBe("succeeded")
  clock = 200
  expect(driver._test.judge(run, snap(["hi there"], { working: true })).state).toBe("running")
  clock = 1300
  expect(driver._test.judge(run, snap(["hi there"], { working: true }))).toEqual({ state: "succeeded", text: "hi there" })
  expect(driver._test.judge(run, { ...snap([]), selected: "b" }).reselect).toBe(true)
})
