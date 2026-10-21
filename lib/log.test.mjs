import { afterEach, expect, spyOn, test } from "bun:test"
import * as plugins from "../index.mjs"

const names = ["MAGPIE_GROK_BOT_DEBUG", "MAGPIE_CLOUD_AGENTS_DEBUG"]
const original = Object.fromEntries(names.map(name => [name, process.env[name]]))
let output

afterEach(() => {
  output?.mockRestore()
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name]
    else process.env[name] = original[name]
  }
})

test("only the Grok Bot plugin is exported", () => {
  expect(Object.keys(plugins).filter(name => name.endsWith("Plugin"))).toEqual(["GrokBotPlugin"])
})

test("plugin startup rejects invalid common configuration with the option path", async () => {
  await expect(plugins.GrokBotPlugin({}, { maxRunMinutes: -1 })).rejects.toThrow("maxRunMinutes")
})

test("default startup and startup failures are silent", async () => {
  for (const name of names) delete process.env[name]
  output = spyOn(console, "error").mockImplementation(() => {})
  await plugins.GrokBotPlugin({})
  await plugins.GrokBotPlugin({}, { progress: "yes" }).catch(() => {})
  expect(output).not.toHaveBeenCalled()
})

for (const name of names) test(`${name} logs startup and failure without configuration secrets`, async () => {
  for (const other of names) delete process.env[other]
  process.env[name] = "1"
  output = spyOn(console, "error").mockImplementation(() => {})
  await plugins.GrokBotPlugin({}, {})
  await plugins.GrokBotPlugin({}, { maxRunMinutes: "private-token" }).catch(() => {})
  const text = output.mock.calls.flat().join(" ")
  expect(text).toContain("[magpie-grok-bot] grok-bot")
  expect(text).toContain("startup")
  expect(text).toContain("failed")
  expect(text).not.toContain("private-token")
})

test("false debug switch stays silent", async () => {
  process.env.MAGPIE_GROK_BOT_DEBUG = "false"
  output = spyOn(console, "error").mockImplementation(() => {})
  await plugins.GrokBotPlugin({})
  expect(output).not.toHaveBeenCalled()
})

test("invalid nested configuration fails at plugin startup", async () => {
  const cases = [
    [[], "options"],
    [{ progress: "yes" }, "progress"],
    [{ maxPromptBytes: 0 }, "maxPromptBytes"],
    [{ grokBot: [] }, "grokBot"],
    [{ grokBot: { ghostMode: "false" } }, "grokBot.ghostMode"],
    [{ grokBot: { persistSessions: 1 } }, "grokBot.persistSessions"],
    [{ grokBot: { reattachPorts: [65536] } }, "grokBot.reattachPorts"],
    [{ grokBot: { settleMs: -1 } }, "grokBot.settleMs"],
    [{ grokBot: { streamPollMs: 0 } }, "grokBot.streamPollMs"],
    [{ grokBot: { appPath: "  " } }, "grokBot.appPath"],
    [{ grokBot: { systemPrompt: "always" } }, "grokBot.systemPrompt"],
    [{ grokBot: { selectors: { row: "" } } }, "grokBot.selectors.row"],
    [{ grokBot: { selectors: "row" } }, "grokBot.selectors"],
  ]
  for (const [options, path] of cases) await expect(plugins.GrokBotPlugin({}, options)).rejects.toThrow(path)
})

test("zero wait and idle durations load", async () => {
  for (const key of ["keepAliveMinutes", "launchTimeoutMs", "appBootMs", "settleMs", "stuckMs", "emptyMs"]) {
    expect(await plugins.GrokBotPlugin({}, { grokBot: { [key]: 0 } })).toHaveProperty("auth")
  }
})

test("cleared optional fields load", async () => {
  for (const options of [{ grokBot: { reattachPorts: null } }, { progress: null }, { grokBot: null }]) {
    expect(await plugins.GrokBotPlugin({}, options)).toHaveProperty("auth")
  }
})

test("logging failures preserve startup and the original configuration error", async () => {
  process.env.MAGPIE_GROK_BOT_DEBUG = "1"
  output = spyOn(console, "error").mockImplementation(() => { throw new Error("EPIPE") })
  expect(await plugins.GrokBotPlugin({})).toHaveProperty("auth")
  await expect(plugins.GrokBotPlugin({}, { progress: "yes" })).rejects.toThrow("Invalid plugin configuration: progress must be a boolean")
})

test("optional defaults and valid options remain accepted", async () => {
  const options = {
    progress: false, maxRunMinutes: 0.5, maxPromptBytes: 1024,
    grokBot: { reattachPorts: [9222], settleMs: 1, streamPollMs: 100, appPath: "/Applications/Grok Bot.app", systemPrompt: "never", sessionHeader: false, persistSessions: false, bringToFront: true, selectors: { row: ".row" } },
  }
  expect(await plugins.GrokBotPlugin({}, options)).toHaveProperty("auth")
})
