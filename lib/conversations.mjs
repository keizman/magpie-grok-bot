import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { textOf } from "./transcript.mjs"

const sha = value => createHash("sha256").update(value).digest("hex")
const DAY = 86400000
const MAX_SEGMENTS = 4

// Each user turn is hashed together with every turn before it, so equal hashes mean an equal history up to that turn.
export function turnHashes(messages) {
  const hashes = []
  let previous = ""
  for (const message of messages) {
    if (message?.role !== "user") continue
    previous = sha(previous + "\u0000" + textOf(message.content))
    hashes.push(previous)
  }
  return hashes
}
export const userTexts = messages => messages.filter(message => message?.role === "user").map(message => textOf(message.content))
export const systemTexts = messages => messages.filter(message => ["system", "developer"].includes(message?.role)).map(message => textOf(message.content)).filter(text => text.trim())

// A conversation is keyed by magpie's session ID; without one, by its model and first user message.
export function conversationKey({ session, messages, model }) {
  if (session) return "s:" + sha("session\u0000" + session).slice(0, 32)
  return "f:" + sha("first\u0000" + (model ?? "") + "\u0000" + (userTexts(messages)[0] ?? "")).slice(0, 32)
}
// Session-keyed conversations get a deterministic first tag so a lost store can be recovered from the chat's markers.
export const baseTag = key => sha("tag\u0000" + key).slice(0, 8)
export const freshTag = () => randomBytes(4).toString("hex")
export const shortHash = hash => hash.slice(0, 6)
export const markerOf = (tag, turn, hash) => `[magpie ${tag}.${turn}.${shortHash(hash)}]`
export const MARKER_PATTERN = /\[magpie ([0-9a-f]{8})\.(\d+)\.([0-9a-f]{6})\]/g

export function parseMarkers(texts) {
  const found = []
  for (const text of texts) for (const match of String(text).matchAll(MARKER_PATTERN)) found.push({ tag: match[1], turn: Number(match[2]), hash: match[3] })
  return found
}

const isPrefix = (prefix, list) => prefix.length <= list.length && prefix.every((value, index) => value === list[index])

/**
 * Decides how a request maps onto the bot's chat.
 *   continue  – a stored segment's delivered turns are a prefix of this request: send only the new user turns.
 *   retry     – the stored segment already delivered this exact last turn: reattach to its reply.
 *   new       – nothing matches and this is the first user turn: open a new tagged segment.
 *   catch-up  – nothing matches but there is earlier history Grok Bot hasn't seen: send it once, folded.
 */
export function planTurn(entry, hashes, { bot, explicitBot = false } = {}) {
  const last = hashes.length - 1
  if (last < 0) return { kind: "new", from: 0 }
  let best
  for (const segment of entry?.segments ?? []) {
    if (explicitBot && segment.bot !== bot) continue
    if (!segment.turns.length || !isPrefix(segment.turns, hashes)) continue
    if (!best || segment.turns.length > best.turns.length) best = segment
  }
  if (best) return { kind: best.turns.length === hashes.length ? "retry" : "continue", segment: best, from: best.turns.length - (best.turns.length === hashes.length ? 1 : 0) }
  return { kind: hashes.length === 1 ? "new" : "catch-up", from: 0 }
}

// Without a stored record, the newest marker this conversation left in the chat tells how far it got.
export function recoverFromMarkers(markers, tag, hashes) {
  let best
  for (const marker of markers) {
    if (marker.tag !== tag || marker.turn >= hashes.length || shortHash(hashes[marker.turn]) !== marker.hash) continue
    if (!best || marker.turn > best.turn) best = marker
  }
  if (!best) return null
  const turns = hashes.slice(0, best.turn + 1)
  return { kind: turns.length === hashes.length ? "retry" : "continue", segment: { tag, turns, recovered: true }, from: turns.length - (turns.length === hashes.length ? 1 : 0) }
}

export function createConversationStore({ file, persist = true, ttlMs = 30 * DAY, cap = 500, now = Date.now, fs = { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync } } = {}) {
  let entries
  function load() {
    if (entries) return entries
    entries = new Map()
    if (!persist || !file) return entries
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"))
      if (data?.version === 1 && data.conversations && typeof data.conversations === "object") {
        for (const [key, value] of Object.entries(data.conversations)) {
          if (Array.isArray(value?.segments) && Number.isFinite(value.updated)) entries.set(key, value)
        }
      }
    } catch {}
    prune()
    return entries
  }
  function prune() {
    for (const [key, value] of entries) if (now() - value.updated > ttlMs) entries.delete(key)
    const sorted = [...entries].sort((left, right) => left[1].updated - right[1].updated)
    while (sorted.length > cap) entries.delete(sorted.shift()[0])
  }
  function save() {
    if (!persist || !file) return
    try {
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, conversations: Object.fromEntries(entries) }), { mode: 0o600 })
      fs.renameSync(temporary, file)
      try { fs.chmodSync(file, 0o600) } catch {}
    } catch {}
  }
  return {
    get(key) { return load().get(key) },
    record(key, { bot, tag, turns }) {
      load()
      const entry = entries.get(key) ?? { segments: [], epoch: 0 }
      const others = entry.segments.filter(segment => segment.tag !== tag)
      const isNew = others.length === entry.segments.length
      const segments = [{ bot, tag, turns: [...turns] }, ...others].slice(0, MAX_SEGMENTS)
      entries.delete(key)
      entries.set(key, { segments, epoch: entry.epoch + (isNew && entry.segments.length ? 1 : 0), updated: now() })
      prune()
      save()
    },
    delete(key) { load(); if (entries.delete(key)) save() },
    get size() { return load().size },
  }
}
