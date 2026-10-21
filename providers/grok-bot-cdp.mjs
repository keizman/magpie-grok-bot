import { randomUUID } from "node:crypto"
import { posix, win32 } from "node:path"
import { chatError } from "../lib/errors.mjs"
import { createCdpApp, connectCdp as connectAppCdp } from "../lib/cdp-app.mjs"
import { sleep } from "../lib/http.mjs"
import { findExecutable, managedProfileDir, ownsRow, platformOf, stateDir } from "../lib/platform.mjs"
import { foldPrompt } from "../lib/transcript.mjs"
import { baseTag, conversationKey, createConversationStore, freshTag, markerOf, parseMarkers, planTurn, recoverFromMarkers, systemTexts, turnHashes, userTexts } from "../lib/conversations.mjs"

export const CDP_ERRORS = {
  missing: "Grok Bot desktop isn't installed — install it (macOS: drag Grok Bot.app into /Applications) and retry, or set grokBot.appPath",
  signedOut: "Grok Bot isn't signed in. Sign in in the Grok Bot window, then retry.",
  running: "Magpie couldn't start Grok Bot — the launch exited before its debug interface opened; quit Grok Bot and retry",
  busy: "Grok Bot is open without its debug interface and grokBot.restartApp is false. Quit Grok Bot and retry (Magpie reopens it with debugging on), or set grokBot.restartApp to true",
  quit: "Grok Bot didn't quit in time for Magpie to reopen it with its debug interface. Quit it yourself (on Windows, also from the tray) and retry",
  changed: "Grok Bot changed its UI; the provider needs an update (run scripts/smoke-test.mjs --inspect to see what changed)",
  crashed: "Grok Bot closed mid-answer — your prompt may still be answered in the app; ask again to re-attach",
  debug: "Grok Bot didn't open its debug interface — another security tool may be blocking it",
}
const failure = key => chatError(key === "signedOut" ? 401 : ["running", "busy", "quit"].includes(key) ? 409 : 502, CDP_ERRORS[key])
export const usesAppProfile = options => (options.profile ?? (options.profileDir ? "managed" : "app")) === "app"
export const connectCdp = (url, options, signal) => connectAppCdp(url, { ...options, failure }, signal)

export async function findGrokBot(dependencies = {}, options = {}) {
  const executable = await findExecutable(dependencies, options)
  if (!executable) throw failure("missing")
  return executable
}

// Selectors for Grok Bot 0.72; each can be overridden with grokBot.selectors.<name> when the app's markup moves.
export const DEFAULT_SELECTORS = {
  chat: ".sand-chat",
  exclude: ".sand-exchange-sheet",
  row: ".sand-transcript-row",
  userRow: "[data-role=\"user\"]",
  assistant: "[data-role=\"assistant\"][role=\"article\"]",
  prose: ".sand-message-prose",
  working: ".sand-activity-line, .sand-message-typing, .sand-typing-indicator",
  busyRow: "[data-pending], [aria-busy=\"true\"]",
  failedRow: "[data-failed]",
  composer: "[role=\"textbox\"][contenteditable=\"plaintext-only\"], [role=\"textbox\"][contenteditable=\"true\"], textarea",
  botItem: "[data-agent-id]",
  selectedBot: "[data-agent-id][data-selected], [data-agent-id][aria-current=\"page\"]",
  signIn: "",
}
export const BINDING = "__magpieGrokStream"
// Keeps a background Magpie window rendering at full speed so the reply streams instead of arriving in bursts.
export const LAUNCH_FLAGS = ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"]

// Runs inside the app page. Text comes from the React props of each reply (the markdown source as it streams), falling back to the rendered text.
const PAGE = String.raw`(selectors) => {
  const VERSION = 4;
  let S = window.__magpieGrok;
  if (!S || S.version !== VERSION) {
    S = { version: VERSION, watchers: new Map() };
    const all = (root, selector) => { if (!selector) return []; try { return [...root.querySelectorAll(selector)]; } catch { return []; } };
    const matches = (element, selector) => { if (!selector) return false; try { return element.matches(selector); } catch { return false; } };
    const text = element => String(element?.innerText ?? element?.textContent ?? "").replace(/\u00a0/g, " ");
    const norm = value => String(value ?? "").replace(/\s+/g, " ").trim();
    const visible = element => !!element && element.getClientRects().length > 0;
    S.source = element => {
      const key = Object.keys(element).find(name => name.startsWith("__reactFiber$"));
      let fiber = key ? element[key] : null;
      for (let depth = 0; fiber && depth < 10; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props && typeof props.content === "string" && "isStreaming" in props) return { text: props.content, streaming: props.isStreaming === true };
      }
      return null;
    };
    S.chat = () => document.querySelector(S.sel.chat) ?? document.body;
    S.rows = () => {
      const chat = S.chat();
      const rows = all(chat, S.sel.row).filter(row => !(S.sel.exclude && row.closest(S.sel.exclude)) && !row.parentElement?.closest(S.sel.row));
      return rows.map((row, order) => ({ row, order, index: Number(row.dataset.index) })).sort((a, b) => (Number.isFinite(a.index) && Number.isFinite(b.index) && a.index !== b.index ? a.index - b.index : a.order - b.order)).map(item => item.row);
    };
    S.isUser = row => matches(row, S.sel.userRow) || all(row, S.sel.userRow).length > 0;
    S.selected = () => document.querySelector(S.sel.selectedBot)?.getAttribute("data-agent-id") ?? null;
    // A target is either a marker string, or (with markers off) an anchor: the prompt text plus the chat position it was sent at.
    S.read = target => {
      const rows = S.rows();
      const chat = S.chat();
      const position = (row, order) => { const index = Number(row.dataset?.index); return Number.isFinite(index) ? index : order; };
      let mine = -1;
      if (typeof target === "string") rows.forEach((row, index) => { if (S.isUser(row) && target && text(row).includes(target)) mine = index; });
      else if (target && typeof target === "object") {
        const want = norm(target.text);
        const users = rows.map((row, index) => index).filter(index => S.isUser(rows[index]) && position(rows[index], index) >= (Number(target.from) || 0));
        const exact = want ? users.filter(index => norm(text(rows[index])).includes(want)) : [];
        mine = (target.last ? exact.at(-1) : exact[0] ?? (target.loose ? users.at(-1) : undefined)) ?? -1;
      }
      const users = rows.filter(S.isUser).map(text).join("\n");
      const out = { selected: S.selected(), found: mine >= 0, at: mine >= 0 ? position(rows[mine], mine) : null, next: rows.length ? Math.max(...rows.map(position)) + 1 : 0, markers: users.match(/\[magpie [0-9a-f]{8}\.\d+\.[0-9a-f]{6}\]/g) ?? [], texts: [], streaming: false, working: false, failed: false, after: 0, userAfter: false, rows: rows.length };
      if (mine < 0) return out;
      if (matches(rows[mine], S.sel.busyRow)) out.working = true;
      if (matches(rows[mine], S.sel.failedRow)) out.failed = true;
      for (const row of rows.slice(mine + 1)) {
        if (S.isUser(row)) { out.userAfter = true; break; }
        out.after++;
        if (matches(row, S.sel.failedRow)) out.failed = true;
        if (matches(row, S.sel.busyRow) || all(row, S.sel.working).length) out.working = true;
        for (const article of all(row, S.sel.assistant)) {
          const prose = S.sel.prose ? article.querySelector(S.sel.prose) : null;
          const source = prose ? S.source(prose) : null;
          if (source?.streaming) out.streaming = true;
          const value = (source ? source.text : text(prose ?? article)).trim();
          if (value) out.texts.push(value);
        }
      }
      if (!out.userAfter && all(chat, S.sel.working).some(element => !element.closest(S.sel.row) && visible(element))) out.working = true;
      return out;
    };
    S.bots = () => {
      const seen = new Map();
      for (const element of all(document, S.sel.botItem)) {
        if (element.closest(S.sel.chat)) continue;
        const id = element.getAttribute("data-agent-id");
        if (!id || seen.has(id)) continue;
        const name = (text(element).split("\n").map(line => line.trim()).find(Boolean) || element.getAttribute("aria-label") || id).slice(0, 80);
        seen.set(id, { id, name, selected: matches(element, S.sel.selectedBot) });
      }
      return [...seen.values()];
    };
    S.select = (id, click) => {
      const items = all(document, S.sel.botItem).filter(element => element.getAttribute("data-agent-id") === id && !element.closest(S.sel.chat));
      if (!items.length) return { ok: false, reason: "missing" };
      if (items.some(element => matches(element, S.sel.selectedBot))) return { ok: true, selected: true };
      if (!click) return { ok: true, selected: false };
      const target = items.find(element => matches(element, "button, a, [role=button], [role=link], [role=option], [role=treeitem]")) ?? items[0];
      target.scrollIntoView?.({ block: "nearest" });
      target.click();
      return { ok: true, selected: false };
    };
    S.composer = () => all(document, S.sel.composer).find(visible) ?? null;
    S.focus = () => {
      const composer = S.composer();
      if (!composer) return { ok: false };
      composer.focus();
      if (composer.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(composer);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } else composer.select?.();
      return { ok: document.activeElement === composer || composer.contains(document.activeElement), text: composer.value ?? text(composer) };
    };
    S.draft = () => { const composer = S.composer(); return composer ? String(composer.value ?? text(composer)) : null; };
    S.signedOut = () => !!(S.sel.signIn && document.querySelector(S.sel.signIn));
    S.watch = (id, target, binding) => {
      S.unwatch(id);
      let last = "", queued = false, ranAt = 0, timer = null;
      const push = () => {
        queued = false; timer = null; ranAt = Date.now();
        let payload;
        try { payload = JSON.stringify({ id, snapshot: S.read(target) }); } catch (error) { payload = JSON.stringify({ id, error: String(error?.message ?? error) }); }
        if (payload === last) return;
        last = payload;
        try { window[binding](payload); } catch {}
      };
      const schedule = () => {
        if (queued) return;
        queued = true;
        const wait = 40 - (Date.now() - ranAt);
        if (wait <= 0) queueMicrotask(push); else timer = setTimeout(push, wait);
      };
      const observer = new MutationObserver(schedule);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-pending", "aria-busy", "data-failed", "data-selected", "aria-current", "data-index", "class"] });
      S.watchers.set(id, () => { observer.disconnect(); if (timer) clearTimeout(timer); });
      schedule();
      return true;
    };
    S.unwatch = id => { S.watchers.get(id)?.(); S.watchers.delete(id); return true; };
    // Markup skeleton for tuning selectors: tags, classes and data attributes only, never text.
    S.inspect = () => {
      const skeleton = (element, depth) => ({
        tag: element.tagName.toLowerCase(),
        class: String(element.className?.baseVal ?? element.className ?? "").split(/\s+/).filter(name => name && !/^sand-[0-9a-z]{5,8}$/.test(name)).join(" "),
        attributes: Object.fromEntries([...element.attributes].filter(attribute => /^(data-|role$|aria-(busy|current|label)$|contenteditable$)/.test(attribute.name)).map(attribute => [attribute.name, attribute.name === "aria-label" ? "…" : attribute.value.slice(0, 40)])),
        children: depth > 0 ? [...element.children].slice(0, 8).map(child => skeleton(child, depth - 1)) : element.children.length,
      });
      const counts = Object.fromEntries(Object.entries(S.sel).map(([key, selector]) => [key, all(document, selector).length]));
      const rows = S.rows();
      const replies = all(S.chat(), S.sel.assistant).map(article => { const prose = S.sel.prose ? article.querySelector(S.sel.prose) : null; const source = prose ? S.source(prose) : null; return { prose: !!prose, reactSource: !!source, streaming: source?.streaming ?? null, length: (source?.text ?? text(article)).length }; });
      return { counts, rows: rows.length, lastRows: rows.slice(-4).map(row => skeleton(row, 4)), replies: replies.slice(-4), composer: S.composer() ? skeleton(S.composer(), 0) : null };
    };
    window.__magpieGrok = S;
  }
  S.sel = selectors;
  return S;
}`

const authProbe = `(async () => {
  const main = window.desktop?.main;
  if (typeof main?.getCursorAuthStatus === "function") {
    try { const status = await main.getCursorAuthStatus(); if (typeof status?.kind === "string") return status.kind === "logged-in"; } catch {}
  }
  let legacy = null;
  try { legacy = await window.desktop?.cursorAccount?.getStatus?.(); } catch {}
  for (const key of ["signedIn", "isSignedIn", "authenticated"]) if (typeof legacy?.[key] === "boolean") return legacy[key];
  const text = document.body?.innerText ?? "";
  return !(/sign in|log in/i.test(text) && !/sign out|log out/i.test(text));
})()`
const botApis = `(async () => {
  const main = window.desktop?.main ?? {};
  const legacy = window.desktop?.agent ?? {};
  const calls = [main.getHostPinnedAgents, main.getServerPinnedAgents, main.listGrokBotTeamAgents, legacy.getPinnedAgents].map((method, index) => typeof method === "function" ? method.call(index < 3 ? main : legacy) : null);
  const rows = await Promise.allSettled(calls);
  return rows.map(row => row.status === "fulfilled" ? row.value : null);
})()`
const botList = value => {
  const list = Array.isArray(value) ? value : value?.agents ?? value?.agentIds ?? value?.pinnedAgentIds ?? value?.pinnedAgents ?? []
  return Array.isArray(list) ? list.flatMap(row => {
    const id = typeof row === "string" ? row : row?.agentId ?? row?.agent_id ?? row?.id
    return typeof id === "string" && id ? [{ id, name: typeof row === "object" ? row?.name ?? row?.displayName ?? row?.title : undefined }] : []
  }) : []
}

const norm = value => String(value ?? "").replace(/\s+/g, " ").trim()
const targetOf = run => run.anchor ?? run.marker
// Whether the composer still holds this prompt: by its marker, or with markers off by the prompt's tail.
const holds = (draft, run) => typeof draft === "string" && (run.marker ? draft.includes(run.marker) : !!norm(run.prompt) && norm(draft).includes(norm(run.prompt).slice(-80)))

const DEFAULTS = { settleMs: 1500, stuckMs: 120000, emptyMs: 20000, sentMs: 8000, selectMs: 8000, streamPollMs: 150, botsMs: 5000 }

export function createGrokBotCdp(options = {}, dependencies = options.dependencies ?? {}) {
  const active = new Map()
  let creating = false
  const selectors = { ...DEFAULT_SELECTORS, ...Object.fromEntries(Object.entries(options.selectors ?? {}).filter(([, value]) => typeof value === "string")) }
  const setting = key => Number.isFinite(options[key]) && options[key] >= 0 ? options[key] : DEFAULTS[key]
  const shared = usesAppProfile(options)
  const app = createCdpApp({
    failure, flag: "magpie-grok-managed", boot: true, notReady: "debug", authorizeLaunch: true, busy: "busy", quitError: "quit",
    shared: () => shared,
    owns: (row, deps) => ownsRow(row, { shared, profileDir: managedProfileDir(deps, options), platform: platformOf(deps) }),
    find: deps => findGrokBot(deps, options),
    probe: `(() => { if (!window.desktop?.main && !window.desktop?.agent) throw new Error("bridge not ready"); return document.readyState !== "loading"; })()`,
    version: value => /GrokBot\//.test(value["User-Agent"] ?? ""),
    pages: list => list.filter(target => target.type === "page" && /^file:\/\//.test(target.url ?? "") && /\/dist\/renderer\//.test(target.url ?? "") && /app\.asar/.test(target.url ?? "")),
    args: deps => [...(shared ? [] : [`--user-data-dir=${managedProfileDir(deps, options)}`]), ...LAUNCH_FLAGS],
    launchError: ({ child, previous }) => failure(previous.length && child.exitCode != null ? "running" : "debug"),
  }, options, dependencies, active)
  const { touch, idle, ensure, checkDrivable } = app
  const deps = app.deps
  const now = () => deps.timers.now()
  const wait = (milliseconds, signal) => sleep(milliseconds, signal, deps.timers)
  const pathApi = platformOf(deps) === "win32" ? win32 : posix
  const store = dependencies.store ?? createConversationStore({ file: pathApi.join(stateDir(deps, options), "conversations.json"), persist: options.persistSessions !== false, now })
  const prepared = new WeakSet()

  const page = (client, call, signal) => client.evaluate(`(${PAGE})(${JSON.stringify(selectors)}).${call}`, signal)
  async function prepare(client, signal) {
    if (prepared.has(client)) return
    prepared.add(client)
    try { await client.call("Emulation.setFocusEmulationEnabled", { enabled: true }, signal) } catch { signal?.throwIfAborted() }
    try { await client.call("Runtime.addBinding", { name: BINDING }, signal); client.bound = true } catch { signal?.throwIfAborted(); client.bound = false }
  }
  async function connect(signal) {
    const client = await ensure(signal)
    await prepare(client, signal)
    return client
  }
  function release(run) {
    run.signal?.removeEventListener("abort", run.onAbort)
    if (active.get(run.bot.id) === run) active.delete(run.bot.id)
  }
  async function signedIn(client, signal) {
    let value
    try { value = await client.evaluate(authProbe, signal) }
    catch (error) { signal?.throwIfAborted(); if (error.bridge) throw failure("changed"); throw error }
    if (!value) throw failure("signedOut")
    if (selectors.signIn && await page(client, "signedOut()", signal)) throw failure("signedOut")
  }
  // A freshly booted window fills its sidebar over a few seconds, so the first read on a connection waits for the list to settle.
  async function bots(client, signal) {
    let list = await readBots(client, signal)
    if (client.botsSettled) return list
    const deadline = now() + setting("botsMs")
    for (let previous = ""; now() < deadline; await wait(400, signal)) {
      const key = list.map(bot => `${bot.id}${bot.selected ? "*" : ""}`).join()
      if (key && key === previous && list.some(bot => bot.selected)) break
      previous = key
      list = await readBots(client, signal)
    }
    client.botsSettled = true
    return list
  }
  async function readBots(client, signal) {
    const fromDom = await page(client, "bots()", signal).catch(() => [])
    const fromApi = await client.evaluate(botApis, signal).catch(() => [])
    const merged = new Map()
    for (const bot of [...(Array.isArray(fromApi) ? fromApi : []).flatMap(botList), ...(Array.isArray(fromDom) ? fromDom : [])]) {
      const previous = merged.get(bot.id)
      merged.set(bot.id, { id: bot.id, name: bot.name || previous?.name || bot.id, selected: !!(bot.selected || previous?.selected) })
    }
    return [...merged.values()]
  }
  async function select(client, bot, signal) {
    const deadline = now() + setting("selectMs")
    for (let attempt = 0; ; attempt++) {
      const result = await page(client, `select(${JSON.stringify(bot.id)}, ${attempt % 20 === 0})`, signal)
      if (!result?.ok) throw chatError(400, `Grok Bot has no bot "${bot.name ?? bot.id}" in its sidebar — pin it in the app or pick another model`)
      if (result.selected && await page(client, "composer() !== null", signal)) return
      if (now() >= deadline) throw failure("changed")
      await wait(150, signal)
    }
  }
  async function read(client, run, signal) {
    try { return await page(client, `read(${JSON.stringify(targetOf(run))})`, signal) }
    catch (error) { signal?.throwIfAborted(); if (!client.open) throw failure("crashed"); if (error.bridge) throw failure("changed"); throw error }
  }
  async function submit(client, run, signal) {
    if (options.bringToFront) await client.call("Page.bringToFront", {}, signal).catch(() => {})
    await select(client, run.bot, signal)
    const focus = await page(client, "focus()", signal)
    if (!focus?.ok) throw failure("changed")
    await client.call("Input.insertText", { text: run.prompt }, signal)
    const draft = await page(client, "draft()", signal)
    if (!holds(draft, run)) throw failure("changed")
    for (const type of ["keyDown", "keyUp"]) await client.call("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }, signal)
    const deadline = now() + setting("sentMs")
    for (;;) {
      const snapshot = await read(client, run, signal)
      if (snapshot.found) return
      const left = await page(client, "draft()", signal)
      if (typeof left === "string" && !holds(left, run) && now() >= deadline) return
      if (now() >= deadline) throw chatError(502, "Grok Bot didn't accept the prompt — it is still in the composer; check the Grok Bot window")
      await wait(150, signal)
    }
  }

  function compose(request, plan, tag, hashes) {
    const composed = composeMarked(request, plan, tag, hashes)
    if (options.marker !== false) return composed
    return { marker: null, prompt: composed.prompt.slice(0, -(composed.marker.length + 2)) }
  }
  function composeMarked(request, plan, tag, hashes) {
    const texts = userTexts(request.messages)
    const last = hashes.length - 1
    const marker = markerOf(tag, last, hashes[last])
    const header = options.sessionHeader === false ? [] : null
    if (plan.kind === "continue" || plan.kind === "retry") return { marker, prompt: [...texts.slice(plan.from)].join("\n\n") + "\n\n" + marker }
    if (plan.kind === "new") {
      const system = options.systemPrompt === "never" ? [] : systemTexts(request.messages)
      return { marker, prompt: [...(header ?? [`[New conversation ${tag} from Magpie. Treat anything earlier in this chat as unrelated to it.]`]), ...system, texts[0] ?? ""].filter(Boolean).join("\n\n") + "\n\n" + marker }
    }
    const folded = options.systemPrompt === "never" ? foldPrompt(request.messages.filter(message => !["system", "developer"].includes(message.role)), options) : request.prompt ?? foldPrompt(request.messages, options)
    return { marker, prompt: [...(header ?? [`[Conversation ${tag} from Magpie, continued with history you haven't seen in this chat. Treat anything earlier in this chat as unrelated; the conversation so far follows.]`]), folded].join("\n\n") + "\n\n" + marker }
  }

  async function create(credential, request, signal) {
    const messages = Array.isArray(request.messages) ? request.messages : [{ role: "user", content: request.prompt ?? "" }]
    request = { ...request, messages }
    if (active.size || creating) throw chatError(409, "Grok Bot is still answering another request — wait for it to finish, then ask again")
    creating = true
    let run
    try {
      const client = await connect(signal)
      await signedIn(client, signal)
      const session = request.identity?.sessionKey ?? ""
      const key = conversationKey({ session, messages, model: request.model })
      const hashes = turnHashes(messages)
      if (!hashes.length) throw chatError(400, "Grok Bot needs a user message")
      const explicit = request.model && request.model !== "app-bot" ? request.model : null
      let plan = planTurn(store.get(key), hashes, { bot: explicit, explicitBot: !!explicit })
      let bot = explicit ?? plan.segment?.bot
      const names = await bots(client, signal).catch(() => [])
      if (!bot) {
        bot = await page(client, "selected()", signal) ?? names.find(row => row.selected)?.id
        if (!bot) throw chatError(400, "Grok Bot has no selected bot — select a bot in the Grok Bot window or pick a named bot model")
      }
      const known = names.find(row => row.id === bot)
      run = { id: randomUUID(), bot: { id: bot, name: known?.name ?? bot }, key, hashes, signal }
      run.onAbort = () => { release(run); idle() }
      active.set(bot, run)
      signal?.addEventListener("abort", run.onAbort, { once: true })
      await select(client, run.bot, signal)
      if (session && plan.kind !== "continue" && plan.kind !== "retry") {
        const snapshot = await read(client, { marker: "" }, signal)
        plan = recoverFromMarkers(parseMarkers(snapshot.markers ?? []), baseTag(key), hashes) ?? plan
      }
      const segment = plan.segment
      const tag = segment?.tag ?? (session && !store.get(key)?.segments?.some(row => row.tag === baseTag(key)) ? baseTag(key) : freshTag())
      Object.assign(run, compose(request, plan, tag, hashes), { tag, plan: plan.kind, ref: `${run.bot.name} · ${plan.kind} ${tag}` })
      if (run.marker) {
        const snapshot = await read(client, run, signal)
        if (snapshot.found) run.reattached = true
        else await submit(client, run, signal)
      } else {
        // Without markers a reply is found by prompt text after the position it was sent at; only a stored retry
        // looks back through the whole chat for the prompt it already delivered.
        const probe = await read(client, { anchor: { text: run.prompt, from: 0, last: true } }, signal)
        if (plan.kind === "retry" && probe.found) { run.anchor = { text: run.prompt, from: probe.at }; run.reattached = true }
        else { run.anchor = { text: run.prompt, from: probe.next ?? 0, loose: true }; await submit(client, run, signal) }
      }
      run.sentAt = now()
      run.changedAt = run.sentAt
      run.busyAt = run.sentAt
      run.lastText = ""
      store.record(key, { bot, tag, turns: hashes })
      return run
    } catch (error) {
      if (run) release(run)
      signal?.throwIfAborted()
      if (error.bridge) throw failure("changed")
      throw error
    } finally { creating = false; idle() }
  }

  function judge(run, snapshot) {
    const at = now()
    if (snapshot.selected && snapshot.selected !== run.bot.id) return { state: "running", reselect: true, progress: `switching back to ${run.bot.name}` }
    const text = (snapshot.texts ?? []).join("\n\n")
    if (text !== run.lastText) { run.lastText = text; run.changedAt = at }
    const busy = !!(snapshot.working || snapshot.streaming)
    if (busy) run.busyAt = at
    const quiet = at - run.changedAt
    if (!snapshot.found) return { state: "running", progress: `waiting for ${run.bot.name} to show the prompt` }
    if (snapshot.failed && !busy && quiet >= setting("settleMs")) return { state: "failed", text: text || "Grok Bot marked the reply as failed" }
    if (text && snapshot.userAfter) return { state: "succeeded", text }
    if (text && !busy && quiet >= setting("settleMs")) return { state: "succeeded", text }
    if (text && !busy) return { state: "running", settleIn: setting("settleMs") - quiet + 5, progress: `${run.bot.name} is finishing` }
    if (text && busy && quiet >= setting("stuckMs")) return { state: "succeeded", text }
    if (!text && !busy && snapshot.after > 0 && at - run.busyAt >= setting("emptyMs") && quiet >= setting("emptyMs")) return { state: "succeeded", text: "" }
    return { state: "running", progress: busy ? (text ? `${run.bot.name} is writing` : `${run.bot.name} is working`) : `waiting for ${run.bot.name}` }
  }
  const finish = (run, verdict) => {
    if (verdict.state === "running") return verdict
    release(run)
    return { state: verdict.state, text: verdict.text, streamText: verdict.text, progress: verdict.text }
  }

  async function stream(credential, run, onEvent, signal) {
    touch()
    const client = await connect(signal)
    let latest, wake
    const unsubscribe = client.on?.("Runtime.bindingCalled", ({ name, payload }) => {
      if (name !== BINDING) return
      try {
        const value = JSON.parse(payload)
        if (value?.id === run.id && value.snapshot) { latest = value.snapshot; wake?.() }
      } catch {}
    })
    let watching = false
    try {
      if (client.bound && unsubscribe) watching = await page(client, `watch(${JSON.stringify(run.id)}, ${JSON.stringify(targetOf(run))}, ${JSON.stringify(BINDING)})`, signal).catch(() => false)
      const interval = watching ? 1000 : setting("streamPollMs") || DEFAULTS.streamPollMs
      let lastProgress
      for (;;) {
        signal?.throwIfAborted()
        if (!client.open) throw failure("crashed")
        const snapshot = latest ?? await read(client, run, signal)
        latest = undefined
        const verdict = judge(run, snapshot)
        if (run.lastText) onEvent({ content: run.lastText })
        if (verdict.progress && verdict.progress !== lastProgress && verdict.state === "running") { lastProgress = verdict.progress; onEvent({ progress: verdict.progress }) }
        if (verdict.reselect) await select(client, run.bot, signal)
        if (verdict.state !== "running") return finish(run, verdict)
        if (latest) continue
        await new Promise(resolve => {
          const timer = deps.timers.setTimeout(done, verdict.settleIn > 0 ? Math.min(interval, verdict.settleIn) : interval)
          function done() { deps.timers.clearTimeout(timer); signal?.removeEventListener("abort", done); wake = undefined; resolve() }
          wake = done
          signal?.addEventListener("abort", done, { once: true })
        })
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error.bridge) throw failure("changed")
      throw error
    } finally {
      unsubscribe?.()
      if (watching && client.open) void page(client, `unwatch(${JSON.stringify(run.id)})`).catch(() => {})
      idle()
    }
  }

  async function poll(credential, run, signal) {
    touch()
    try {
      let client = app.connection
      if (!client?.open) {
        app.disconnect()
        client = await connect(signal)
        await signedIn(client, signal)
      }
      await prepare(client, signal)
      const verdict = judge(run, await read(client, run, signal))
      if (verdict.reselect) await select(client, run.bot, signal)
      const outcome = finish(run, verdict)
      return outcome.state === "running" ? { ...outcome, partial: run.lastText || undefined } : outcome
    } catch (error) {
      signal?.throwIfAborted()
      if (error.status === 401 || error.message === CDP_ERRORS.changed) release(run)
      if (error.bridge) throw failure("changed")
      throw error
    } finally { idle() }
  }

  return {
    id: "grok-bot", name: "Grok Bot",
    async authorize() {
      return { url: "", method: "auto", instructions: (shared
        ? "Magpie uses your installed Grok Bot and its existing sign-in. If Grok Bot is open without its debug interface, Magpie quits it and reopens it with debugging on (set grokBot.restartApp to false to prevent that). Sign in there if you haven't."
        : "Magpie opens its own Grok Bot window with a separate profile (or attaches to a debug-enabled window you list in grokBot.reattachPorts). Sign in once in that window; your usual Grok Bot can stay open.") + " Each conversation is a tagged segment in the selected bot's chat: Magpie sends only new messages to it, and a short [magpie …] marker is appended to each prompt to match its reply. No credential leaves the app.", callback: async () => {
        try { await checkDrivable(); return { type: "success", refresh: "grok-bot-cdp", access: "app-local", expires: 0, accountId: "grok-bot-cdp", mechanism: "cdp" } }
        catch (error) { return { type: "failed", error: error.message } }
      } }
    },
    async liveModels(credential, signal) {
      try { const client = await connect(signal); await signedIn(client, signal); return Object.fromEntries((await bots(client, signal)).map(bot => [bot.id, { name: bot.name, tool_call: false }])) }
      catch (error) { if (error.status === 401) throw error; return {} }
      finally { idle() }
    },
    async status(signal) {
      const client = await connect(signal)
      try {
        let signed = true
        try { await signedIn(client, signal) } catch (error) { if (error.status !== 401) throw error; signed = false }
        return { signedIn: signed, bots: signed ? await bots(client, signal) : [] }
      } finally { idle() }
    },
    async inspect(signal) {
      const client = await connect(signal)
      try {
        const bridge = await client.evaluate(`({ desktop: Object.keys(window.desktop ?? {}), main: Object.keys(window.desktop?.main ?? {}).filter(name => /agent|auth|pinned|session|transcript|status/i.test(name)).sort(), mount: Object.keys(window.desktopMount ?? {}), legacyAgent: Object.keys(window.desktop?.agent ?? {}).length })`, signal)
        return { bridge, binding: !!client.bound, page: await page(client, "inspect()", signal) }
      } finally { idle() }
    },
    create, stream, poll,
    cancel(credential, run) { if (active.get(run.bot.id) === run) release(run); idle() },
    dispose: app.dispose,
    _test: { judge, compose, store, selectors, PAGE },
  }
}
