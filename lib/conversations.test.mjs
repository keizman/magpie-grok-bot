import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { baseTag, conversationKey, createConversationStore, markerOf, parseMarkers, planTurn, recoverFromMarkers, turnHashes } from "./conversations.mjs"

const user = content => ({ role: "user", content })
const bot = content => ({ role: "assistant", content })
const history = (...texts) => texts.flatMap((text, index) => index ? [bot("ok"), user(text)] : [user(text)])

test("turn hashes chain, so a changed earlier turn changes every later hash", () => {
  const [a1, a2] = turnHashes(history("one", "two"))
  const [b1, b2] = turnHashes(history("ONE", "two"))
  expect(a1).not.toBe(b1)
  expect(a2).not.toBe(b2)
  expect(turnHashes([{ role: "system", content: "s" }, ...history("one", "two")])).toEqual([a1, a2])
  expect(turnHashes([user([{ type: "text", text: "one" }])])[0]).toBe(a1)
})

test("conversations are keyed by session, or by model and first message without one", () => {
  expect(conversationKey({ session: "abc", messages: history("x") })).toBe(conversationKey({ session: "abc", messages: history("y") }))
  expect(conversationKey({ session: "", messages: history("x", "y"), model: "m" })).toBe(conversationKey({ messages: history("x"), model: "m" }))
  expect(conversationKey({ messages: history("x"), model: "m" })).not.toBe(conversationKey({ messages: history("x"), model: "n" }))
})

test("planning: new, continue, retry, branch and unseen history", () => {
  const one = turnHashes(history("a"))
  const two = turnHashes(history("a", "b"))
  const entry = { segments: [{ bot: "bot", tag: "aaaaaaaa", turns: one }] }
  expect(planTurn(undefined, one)).toEqual({ kind: "new", from: 0 })
  expect(planTurn(undefined, two)).toEqual({ kind: "catch-up", from: 0 })
  expect(planTurn(entry, two)).toMatchObject({ kind: "continue", from: 1, segment: { tag: "aaaaaaaa" } })
  expect(planTurn(entry, one)).toMatchObject({ kind: "retry", from: 0 })
  expect(planTurn(entry, turnHashes(history("A", "b")))).toEqual({ kind: "catch-up", from: 0 })
  expect(planTurn(entry, turnHashes(history("other")))).toEqual({ kind: "new", from: 0 })
  expect(planTurn(entry, two, { bot: "another", explicitBot: true })).toEqual({ kind: "catch-up", from: 0 })
})

test("planning picks the longest matching segment, so a stray request doesn't break the conversation", () => {
  const long = turnHashes(history("a", "b"))
  const entry = { segments: [{ bot: "bot", tag: "11111111", turns: turnHashes(history("title please")) }, { bot: "bot", tag: "22222222", turns: long }] }
  expect(planTurn(entry, turnHashes(history("a", "b", "c")))).toMatchObject({ kind: "continue", from: 2, segment: { tag: "22222222" } })
})

test("markers recover a conversation only when their hash matches this history", () => {
  const hashes = turnHashes(history("a", "b", "c"))
  const tag = baseTag("s:key")
  const text = `hello\n\n${markerOf(tag, 0, hashes[0])}\nlater ${markerOf(tag, 1, hashes[1])} ${markerOf("ffffffff", 2, hashes[2])}`
  const markers = parseMarkers([text])
  expect(markers).toHaveLength(3)
  expect(recoverFromMarkers(markers, tag, hashes)).toMatchObject({ kind: "continue", from: 2, segment: { tag, turns: hashes.slice(0, 2) } })
  expect(recoverFromMarkers(markers, tag, hashes.slice(0, 2))).toMatchObject({ kind: "retry", from: 1 })
  expect(recoverFromMarkers(markers, tag, turnHashes(history("A", "b", "c")))).toBeNull()
  expect(recoverFromMarkers([], tag, hashes)).toBeNull()
})

test("the store persists hashes only, with private file permissions and atomic replacement", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-store-"))
  try {
    const file = join(dir, "nested", "conversations.json")
    const store = createConversationStore({ file })
    const turns = turnHashes(history("my secret question"))
    store.record("s:key", { bot: "bot", tag: "aaaaaaaa", turns })
    const raw = readFileSync(file, "utf8")
    expect(raw).not.toContain("secret")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700)
    const reloaded = createConversationStore({ file })
    expect(reloaded.get("s:key").segments[0]).toEqual({ bot: "bot", tag: "aaaaaaaa", turns })
    reloaded.record("s:key", { bot: "bot", tag: "bbbbbbbb", turns })
    expect(createConversationStore({ file }).get("s:key")).toMatchObject({ epoch: 1, segments: [{ tag: "bbbbbbbb" }, { tag: "aaaaaaaa" }] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the store expires old conversations, caps its size and survives a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "grok-store-"))
  try {
    const file = join(dir, "conversations.json")
    writeFileSync(file, "{not json")
    let clock = 0
    const store = createConversationStore({ file, ttlMs: 1000, cap: 2, now: () => clock })
    expect(store.size).toBe(0)
    for (const key of ["a", "b", "c"]) { clock++; store.record(key, { bot: "x", tag: "aaaaaaaa", turns: ["h"] }) }
    expect(store.get("a")).toBeUndefined()
    expect(store.size).toBe(2)
    clock += 5000
    expect(createConversationStore({ file, ttlMs: 1000, now: () => clock }).size).toBe(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a memory-only store never touches the disk", () => {
  const fs = new Proxy({}, { get: () => () => { throw new Error("disk access") } })
  const store = createConversationStore({ file: "/nonexistent/x.json", persist: false, fs })
  store.record("k", { bot: "b", tag: "aaaaaaaa", turns: ["h"] })
  expect(store.get("k").segments).toHaveLength(1)
})
