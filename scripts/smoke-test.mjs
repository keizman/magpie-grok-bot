#!/usr/bin/env node
// Real-app smoke test for the Grok Bot desktop driver (macOS or Windows, Node 22+).
//
//   node scripts/smoke-test.mjs                 run every step against the selected bot
//   node scripts/smoke-test.mjs --bot <id>      use a specific bot (ids are listed at start)
//   node scripts/smoke-test.mjs --skip-extra    skip the catch-up step
//   node scripts/smoke-test.mjs --inspect       print bridge names and a text-free markup skeleton, then exit
//   node scripts/smoke-test.mjs --keep-open     leave Magpie's managed Grok Bot window running afterwards
//   node scripts/smoke-test.mjs --managed       use a separate Magpie profile instead of your signed-in app
//
// It loads index.mjs the way Magpie does and sends real messages to the bot, printing
// every streamed chunk with a timestamp. Steps:
//   1. session A, turn 1: ask the bot to remember 4721
//   2. session A, turn 2 (full history sent, as Magpie does): the reply must contain 4721
//   3. a fresh plugin instance (simulated Magpie restart) continues session A; the store must
//      show the same segment, which proves only the new turn was sent
//   4. session B: a new conversation gets its own segment
//   5. catch-up: a conversation with history Grok Bot never saw is sent once, folded
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const root = new URL("..", import.meta.url)
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
const { GrokBotPlugin } = await import(new URL("index.mjs", root).href)
const { createGrokBotCdp } = await import(new URL("providers/grok-bot-cdp.mjs", root).href)
const { conversationKey } = await import(new URL("lib/conversations.mjs", root).href)

const stateDir = mkdtempSync(join(tmpdir(), "magpie-grok-smoke-"))
const grokBot = { stateDir, keepAliveMinutes: 30, ...(value("--app") ? { appPath: value("--app") } : {}), ...(flag("--managed") ? { profile: "managed" } : {}) }
const started = Date.now()
const stamp = () => `[${((Date.now() - started) / 1000).toFixed(3).padStart(8)}s]`
const log = (...parts) => console.log(stamp(), ...parts)
const results = []
const check = (name, ok, detail = "") => { results.push({ name, ok }); log(ok ? "PASS" : "FAIL", name, detail) }

const owner = createGrokBotCdp(grokBot)
let exitCode = 0
try {
  log(grokBot.profile === "managed" ? "launching or attaching to Magpie's own Grok Bot window (separate profile)…" : "attaching to your Grok Bot (if it's open without its debug interface, it quits and reopens with debugging on)…")
  const flow = await owner.authorize()
  const authorized = await flow.callback()
  if (authorized.type !== "success") throw new Error(authorized.error)
  let status = await owner.status()
  if (!status.signedIn) {
    log("Grok Bot isn't signed in. Sign in in the Grok Bot window that just opened; waiting up to 5 minutes…")
    const deadline = Date.now() + 5 * 60000
    while (!status.signedIn && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 3000)); status = await owner.status() }
    if (!status.signedIn) throw new Error("still signed out after 5 minutes")
  }
  log("signed in; bots:")
  for (const bot of status.bots) console.log(`           ${bot.selected ? "*" : " "} ${bot.id}  ${bot.name}`)
  if (flag("--inspect")) {
    console.log(JSON.stringify(await owner.inspect(), null, 2))
  } else {
    const model = value("--bot") ?? (status.bots.some(bot => bot.selected) ? "app-bot" : status.bots[0]?.id)
    if (!model) throw new Error("no bot found — create or pin a bot in Grok Bot first")
    log(`using model ${model}${model === "app-bot" ? " (the bot selected in the app)" : ""}`)
    await run(model)
  }
} catch (error) {
  exitCode = 1
  log("ERROR", error?.message ?? error)
} finally {
  if (!flag("--keep-open")) await owner.dispose()
  rmSync(stateDir, { recursive: true, force: true })
  if (results.length) {
    console.log("\nSummary:")
    for (const result of results) console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${result.name}`)
    if (results.some(result => !result.ok)) exitCode = 1
  }
  process.exit(exitCode)
}

async function plugin() {
  const hooks = await GrokBotPlugin({}, { grokBot })
  const auth = { type: "oauth", access: "app-local", refresh: "grok-bot-cdp", accountId: "grok-bot-cdp", mechanism: "cdp", expires: 0 }
  const { fetch, baseURL } = await hooks.auth.loader(async () => auth)
  return { hooks, fetch, baseURL }
}

async function turn(instance, label, session, model, messages) {
  const output = {}
  await instance.hooks["chat.headers"]({ model: { providerID: "grok-bot" }, sessionID: session }, output)
  log(`── ${label}`)
  const sent = Date.now()
  const response = await instance.fetch(instance.baseURL + "/chat/completions", { method: "POST", headers: output.headers, body: JSON.stringify({ model, stream: true, messages }) })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = "", text = "", chunks = 0, firstAt
  for (;;) {
    const { value: bytes, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(bytes, { stream: true })
    for (let index; (index = buffer.indexOf("\n\n")) >= 0;) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue
      const event = JSON.parse(line.slice(6))
      if (event.error) throw new Error(event.error.message)
      const delta = event.choices?.[0]?.delta ?? {}
      if (delta.reasoning_content) log("  progress", JSON.stringify(delta.reasoning_content))
      if (delta.content) {
        chunks++
        firstAt ??= Date.now()
        text += delta.content
        log("  content ", JSON.stringify(delta.content))
      }
    }
  }
  log(`  reply (${chunks} content chunks, first after ${firstAt ? ((firstAt - sent) / 1000).toFixed(2) + "s" : "—"}, total ${((Date.now() - sent) / 1000).toFixed(2)}s):`)
  console.log(text.split("\n").map(line => "           | " + line).join("\n"))
  return { text, chunks }
}

function storeEntry(session, model, messages) {
  try {
    const data = JSON.parse(readFileSync(join(stateDir, "conversations.json"), "utf8"))
    return data.conversations[conversationKey({ session, messages, model })]
  } catch { return undefined }
}

async function run(model) {
  const first = await plugin()
  const sessionA = `smoke-a-${randomUUID()}`
  const a1 = [{ role: "user", content: "Please remember the number 4721 for this conversation. Reply with a short acknowledgement only." }]
  const r1 = await turn(first, "session A, turn 1 (new segment)", sessionA, model, a1)
  check("turn 1 got a reply", r1.text.trim().length > 0)
  check("turn 1 streamed in more than one chunk", r1.chunks > 1, `(${r1.chunks} chunks; a very short reply can arrive in one)`)
  const tagA = storeEntry(sessionA, model, a1)?.segments?.[0]?.tag

  const a2 = [...a1, { role: "assistant", content: r1.text }, { role: "user", content: "What number did I ask you to remember? Reply with just the number." }]
  const r2 = await turn(first, "session A, turn 2 (full history sent; only the new turn should reach Grok Bot)", sessionA, model, a2)
  check("turn 2 remembers 4721", /4721/.test(r2.text))
  const entry2 = storeEntry(sessionA, model, a2)
  check("turn 2 continued the same segment", entry2?.segments?.[0]?.tag === tagA && entry2?.segments?.[0]?.turns?.length === 2, `(tag ${tagA})`)

  const restarted = await plugin()
  const a3 = [...a2, { role: "assistant", content: r2.text }, { role: "user", content: "Add one to that number. Reply with just the result." }]
  const r3 = await turn(restarted, "session A, turn 3 after a simulated Magpie restart", sessionA, model, a3)
  check("turn 3 answers 4722", /4722/.test(r3.text))
  const entry3 = storeEntry(sessionA, model, a3)
  check("restart reused the stored segment (only the new turn was sent)", entry3?.segments?.length === 1 && entry3.segments[0].tag === tagA && entry3.segments[0].turns.length === 3)

  const sessionB = `smoke-b-${randomUUID()}`
  const b1 = [{ role: "user", content: "This is a new conversation. In one short sentence, say hello and name one planet." }]
  const rb = await turn(restarted, "session B, turn 1 (a second, separate segment)", sessionB, model, b1)
  check("session B got a reply", rb.text.trim().length > 0)
  const tagB = storeEntry(sessionB, model, b1)?.segments?.[0]?.tag
  check("session B has its own segment", !!tagB && tagB !== tagA, `(tag ${tagB})`)

  if (!flag("--skip-extra")) {
    const sessionC = `smoke-c-${randomUUID()}`
    const c = [
      { role: "user", content: "My favourite colour is teal." },
      { role: "assistant", content: "Got it — teal." },
      { role: "user", content: "What is my favourite colour? Reply with one word." },
    ]
    const rc = await turn(restarted, "session C (history Grok Bot never saw → one-time catch-up)", sessionC, model, c)
    check("catch-up carried the earlier history", /teal/i.test(rc.text))
  }
}
