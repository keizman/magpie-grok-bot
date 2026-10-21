import { expect, test } from "bun:test"
import { makeGrokBotDriver } from "../providers/grok-bot.mjs"
import { SESSION_HEADER } from "./sessions.mjs"

const provider = makeGrokBotDriver({})
const id = provider.auth.provider

test("missing headers are initialized for this provider", async () => {
  const output = {}
  await provider["chat.headers"]({ model: { providerID: id }, sessionID: "session-one" }, output)
  expect(output.headers?.[SESSION_HEADER]).toBe("session-one")
})
test("another provider never receives the session header", async () => {
  const output = { headers: { authorization: "existing" } }
  await provider["chat.headers"]({ model: { providerID: "external" }, sessionID: "private" }, output)
  expect(output.headers).toEqual({ authorization: "existing" })
})
test("model provider takes precedence over conflicting provider metadata", async () => {
  const output = {}
  await provider["chat.headers"]({ model: { providerID: "external" }, provider: { info: { id } }, sessionID: "private" }, output)
  expect(output.headers).toBeUndefined()
})
test("provider metadata fallback preserves existing headers", async () => {
  const output = { headers: { authorization: "existing" } }
  await provider["chat.headers"]({ provider: { info: { id } }, sessionID: "session-one" }, output)
  expect(output.headers).toEqual({ authorization: "existing", [SESSION_HEADER]: "session-one" })
})
