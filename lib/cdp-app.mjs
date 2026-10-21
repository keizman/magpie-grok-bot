import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { clock, fetchWithTimeout, sleep, withTimeout } from "./http.mjs"
import { processDependencies, samePath } from "./platform.mjs"

export { PROCESS_PROJECTION, stopScript } from "./platform.mjs"
const managedPattern = /^[1-9]\d*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
export async function connectCdp(url, { WebSocket: Socket = globalThis.WebSocket, timers = clock, timeoutMs = 10000, failure } = {}, signal) {
  const address = new URL(url)
  if (address.protocol !== "ws:" || address.hostname !== "127.0.0.1" || address.username || address.password) throw failure("debug")
  const socket = new Socket(url)
  let sequence = 0
  const pending = new Map()
  const listeners = new Map()
  const disconnected = () => { for (const job of pending.values()) job.reject(failure("crashed")); pending.clear() }
  socket.addEventListener("close", disconnected)
  socket.addEventListener("error", disconnected)
  socket.addEventListener("message", event => {
    let frame
    try { frame = JSON.parse(String(event.data)) } catch { return }
    if (frame.id == null && typeof frame.method === "string") {
      for (const listener of [...(listeners.get(frame.method) ?? [])]) { try { listener(frame.params ?? {}) } catch {} }
      return
    }
    const job = pending.get(frame.id)
    if (!job) return
    pending.delete(frame.id)
    if (frame.error || frame.result?.exceptionDetails) {
      const description = frame.error?.message ?? frame.result.exceptionDetails.exception?.description ?? frame.result.exceptionDetails.text
      job.reject(Object.assign(new Error(String(description)), { bridge: true }))
    } else job.resolve(frame.result)
  })
  try {
    await withTimeout(() => new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true })
      socket.addEventListener("error", () => reject(failure("debug")), { once: true })
      socket.addEventListener("close", () => reject(failure("debug")), { once: true })
    }), signal, timeoutMs, timers)
  } catch (error) { socket.close(); throw error }
  async function call(method, params, callSignal) {
    const id = ++sequence
    try {
      return await withTimeout(() => new Promise((resolve, reject) => {
        if (socket.readyState !== 1) return reject(failure("crashed"))
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      }), callSignal, timeoutMs, timers)
    } finally { pending.delete(id) }
  }
  return { get open() { return socket.readyState === 1 }, call,
    async evaluate(expression, callSignal) { return (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, callSignal))?.result?.value },
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, new Set())
      listeners.get(method).add(listener)
      return () => { listeners.get(method)?.delete(listener) }
    },
    close() { disconnected(); listeners.clear(); socket.close() },
  }
}

const hosts = new WeakMap()
function register(host, dispose) {
  let entry = hosts.get(host)
  if (!entry) {
    const callbacks = new Set()
    const beforeExit = () => { for (const callback of [...callbacks]) void callback() }
    const exit = () => { for (const callback of [...callbacks]) callback(true) }
    const signals = new Map()
    for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
      const handler = () => {
        const otherHandlers = host.listeners(signal).some(listener => listener !== handler)
        void Promise.allSettled([...callbacks].map(callback => callback())).then(() => {
          if (!otherHandlers) host.exit(code)
        })
      }
      signals.set(signal, handler)
      host.on(signal, handler)
    }
    entry = { callbacks, beforeExit, exit, signals }
    hosts.set(host, entry)
    host.on("beforeExit", beforeExit)
    host.on("exit", exit)
  }
  entry.callbacks.add(dispose)
  return () => {
    entry.callbacks.delete(dispose)
    if (!entry.callbacks.size) {
      host.removeListener("beforeExit", entry.beforeExit)
      host.removeListener("exit", entry.exit)
      for (const [signal, handler] of entry.signals) host.removeListener(signal, handler)
      hosts.delete(host)
    }
  }
}
const sameProcess = (current, expected) => current.pid === expected.pid && current.created === expected.created && current.executable === expected.executable && current.managedTag === expected.managedTag
export function createCdpApp(adapter, options, dependencies, active) {
  const { failure } = adapter
  const platform = dependencies.platform ?? process.platform
  const deps = { env: process.env, platform, spawn, freePort, fetch: globalThis.fetch, timers: clock, host: process, ...processDependencies(adapter.flag, platform), ...dependencies }
  const timers = deps.timers
  async function find() {
    const executable = await adapter.find(deps)
    deps.setExecutable?.(executable)
    return executable
  }
  let connection, connecting, owned, idleTimer, unregister, closing, disposing = false
  const touch = () => timers.clearTimeout(idleTimer)
  const disconnect = () => { connection?.close(); connection = undefined }
  function dispose(sync = false) {
    touch(); disconnect()
    if (connecting && !sync) {
      disposing = true
      return connecting.catch(() => {}).then(() => dispose())
    }
    disposing = true
    const row = owned
    owned = undefined
    unregister?.(); unregister = undefined
    if (!row) return closing
    if (sync) { deps.stopManagedSync(row); return }
    closing = deps.processes().then(rows => {
      if (rows.some(current => sameProcess(current, row)) && (!row.orphan || !deps.parentAlive(Number(row.managedTag.split(":")[0])))) return deps.stopManaged(row)
    }).catch(() => {}).finally(() => { closing = undefined })
    return closing
  }
  function idle() {
    touch()
    if (active.size || connecting || disposing) return
    const minutes = options.keepAliveMinutes ?? 1
    idleTimer = timers.setTimeout(() => { void dispose() }, (Number.isFinite(minutes) && minutes >= 0 ? minutes : 1) * 60000)
    idleTimer?.unref?.()
  }
  async function version(port, signal) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false
    try {
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/version`, { signal, redirect: "error" }, { fetch: deps.fetch, timeoutMs: 800 })
      return adapter.version(await response.json())
    } catch { signal?.throwIfAborted(); return false }
  }
  async function attach(port, signal, bootMs = 0) {
    bootMs = Number.isFinite(bootMs) && bootMs >= 0 ? bootMs : 15000
    const deadline = timers.now() + bootMs
    for (;;) {
      signal?.throwIfAborted()
      const response = await fetchWithTimeout(`http://127.0.0.1:${port}/json/list`, { signal, redirect: "error" }, { fetch: deps.fetch, timeoutMs: 2000 })
      const list = await response.json()
      const pages = adapter.pages(Array.isArray(list) ? list : [])
      let lastError
      for (const page of pages) {
        const endpoint = new URL(page.webSocketDebuggerUrl)
        if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== port || endpoint.username || endpoint.password) continue
        const client = await (deps.connect ?? connectCdp)(endpoint.href, { timers, WebSocket: deps.WebSocket, failure }, signal)
        let accepted = false
        try {
          accepted = !adapter.probe || await client.evaluate(adapter.probe, signal)
          if (accepted) return client
        } catch (error) { lastError = error; signal?.throwIfAborted() }
        finally { if (!accepted) client.close() }
      }
      const remaining = deadline - timers.now()
      if (remaining <= 0) throw lastError ?? failure(adapter.notReady ?? (adapter.probe ? "signedOut" : "debug"))
      await sleep(Math.min(250, remaining), signal, timers)
    }
  }
  async function runningProcesses() { try { return await deps.processes() } catch { throw failure("debug") } }
  async function reattach(previous, signal) {
    let lastError
    for (const port of [...new Set([...(options.reattachPorts ?? []), ...previous.map(row => row.port)])]) {
      if (!await version(port, signal)) continue
      try { return { port, client: await attach(port, signal) } } catch (error) { signal?.throwIfAborted(); lastError = error }
    }
    if (lastError) throw lastError
  }
  async function start(signal) {
    await closing
    const executable = await find()
    const previous = await runningProcesses()
    const attached = await reattach(previous, signal)
    if (attached) {
      const row = previous.find(row => row.port === attached.port && row.created && samePath(row.executable, executable, platform) && managedPattern.test(row.managedTag ?? ""))
      if (row && !deps.parentAlive(Number(row.managedTag.split(":")[0]))) owned = { ...row, orphan: true }
      return attached.client
    }
    if (owned) {
      const previousOwned = owned
      owned = undefined
      const rows = await runningProcesses()
      if (rows.some(row => sameProcess(row, previousOwned)) && (!previousOwned.orphan || !deps.parentAlive(Number(previousOwned.managedTag.split(":")[0])))) await deps.stopManaged(previousOwned)
    }
    const port = await deps.freePort()
    const managedTag = `${process.pid}:${randomUUID()}`
    const child = deps.spawn(executable, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", `--${adapter.flag}=${managedTag}`, ...(adapter.args?.(deps) ?? [])], { stdio: "ignore", windowsHide: false, ...(adapter.spawnOptions?.(deps) ?? {}) })
    let spawnError
    child.once?.("error", error => { spawnError = error })
    const pin = async () => {
      if (owned) return
      const row = (await runningProcesses()).find(row => row.pid === child.pid && row.managedTag === managedTag && samePath(row.executable, executable, platform) && row.created)
      if (row) owned = { ...row }
    }
    await pin()
    const started = timers.now()
    while (timers.now() - started < (options.launchTimeoutMs ?? 10000)) {
      signal?.throwIfAborted()
      await pin()
      if (await version(port, signal)) return attach(port, signal, adapter.boot ? options.appBootMs ?? 15000 : 0)
      if (spawnError || child.exitCode != null) break
      await sleep(200, signal, timers)
    }
    throw adapter.launchError({ spawnError, child, previous })
  }
  async function ensure(signal) {
    touch()
    if (connection?.open) return connection
    if (!connecting) {
      disposing = false
      unregister ??= register(deps.host, dispose)
      connecting = start(signal).then(value => {
        if (disposing) { value.close(); throw failure("crashed") }
        return connection = value
      }).catch(error => { signal?.throwIfAborted(); if (error.status) throw error; throw failure("debug") }).finally(() => { connecting = undefined; idle() })
    }
    return connecting
  }
  async function checkDrivable() {
    await find()
    if (connection?.open) return
    if (adapter.authorizeLaunch) await ensure()
    else { const attached = await reattach(await runningProcesses()); attached?.client.close() }
  }
  return { deps, get connection() { return connection }, touch, idle, disconnect, ensure, checkDrivable, dispose }
}
