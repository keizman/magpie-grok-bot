import { execFile, spawnSync } from "node:child_process"
import { access, readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { delimiter, join, posix, win32 } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
export const APP_NAME = "Grok Bot"
const managedPattern = /^[1-9]\d*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const exists = path => access(path).then(() => true, () => false)
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function platformOf(deps = {}) { return deps.platform ?? process.platform }
export function homeOf(deps = {}) { return deps.env?.HOME || deps.home || homedir() }
export const samePath = (left, right, platform = process.platform) => typeof left === "string" && typeof right === "string" && (platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right)

// Folder Magpie owns for this provider: the managed app profile and the session store live under it.
export function magpieDir(deps = {}) {
  const env = deps.env ?? process.env
  const platform = platformOf(deps)
  if (platform === "darwin") return posix.join(homeOf(deps), "Library", "Application Support", "Magpie")
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || tmpdir(), "Magpie")
  return posix.join(env.XDG_STATE_HOME || posix.join(homeOf(deps), ".local", "state"), "magpie")
}
export const managedProfileDir = (deps = {}, options = {}) => options.profileDir ?? (platformOf(deps) === "win32" ? win32 : posix).join(magpieDir(deps), "grok-bot-managed-profile")
export const stateDir = (deps = {}, options = {}) => options.stateDir ?? (platformOf(deps) === "win32" ? win32 : posix).join(magpieDir(deps), "grok-bot")

// Reads CFBundleExecutable from an XML plist directly and from a binary plist through plutil, which ships with macOS.
export async function bundleExecutable(bundle, deps = {}) {
  const plist = posix.join(bundle, "Contents", "Info.plist")
  const reader = deps.readFile ?? readFile
  let name
  let raw
  try { raw = await reader(plist) } catch { return null }
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))
  if (bytes.subarray(0, 6).toString("latin1") === "bplist") {
    try {
      const { stdout } = await (deps.execFile ?? execute)("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { timeout: 5000 })
      name = JSON.parse(String(stdout)).CFBundleExecutable
    } catch { name = undefined }
  } else {
    const match = bytes.toString("utf8").match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/)
    name = match?.[1]?.trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, "\"")
  }
  if (typeof name !== "string" || !name || name.includes("/")) return null
  return posix.join(bundle, "Contents", "MacOS", name)
}

export function macBundles(deps = {}, options = {}) {
  const home = homeOf(deps)
  const configured = options.appPath && /\.app\/?$/.test(options.appPath) ? [options.appPath.replace(/\/$/, "")] : []
  return [...configured, `/Applications/${APP_NAME}.app`, posix.join(home, "Applications", `${APP_NAME}.app`)]
}

export async function findExecutable(deps = {}, options = {}) {
  const env = deps.env ?? process.env
  const check = deps.exists ?? exists
  const platform = platformOf(deps)
  if (options.appPath && !/\.app\/?$/.test(options.appPath) && await check(options.appPath)) return options.appPath
  if (platform === "darwin") {
    for (const bundle of macBundles(deps, options)) {
      if (!await check(bundle)) continue
      const executable = await bundleExecutable(bundle, deps) ?? posix.join(bundle, "Contents", "MacOS", APP_NAME)
      if (await check(executable)) return executable
    }
    return null
  }
  if (platform === "win32") {
    const roots = [env.ProgramFiles && win32.join(env.ProgramFiles, APP_NAME), env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", APP_NAME), ...(env.PATH ?? env.Path ?? "").split(";").filter(Boolean)]
    for (const root of roots.filter(Boolean)) {
      const candidate = win32.join(root.replace(/^"|"$/g, ""), `${APP_NAME}.exe`)
      if (await check(candidate)) return candidate
    }
    return null
  }
  for (const root of ["/opt/Grok Bot", ...(env.PATH ?? "").split(delimiter).filter(Boolean)]) {
    for (const name of ["grok-bot", APP_NAME]) {
      const candidate = join(root, name)
      if (await check(candidate)) return candidate
    }
  }
  return null
}

const tagOf = (command, flag) => command?.match(new RegExp(`--${flag}=([0-9]+:[0-9a-f-]+)`))?.[1]
const portOf = command => Number(command?.match(/--remote-debugging-port[= ](\d+)/)?.[1]) || undefined
const hasTag = (command, flag, tag) => new RegExp(`(?:^|\\s)--${flag}=${escape(tag)}(?=\\s|$)`).test(command ?? "")

// `ps -o lstart=` prints the start time in a fixed C-locale shape, which stays stable for the life of a process.
const PS_LINE = /^\s*(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/
export function parsePs(stdout, executable, flag) {
  const rows = []
  for (const line of String(stdout).split("\n")) {
    const match = line.match(PS_LINE)
    if (!match) continue
    const [, pid, created, command] = match
    if (command !== executable && !command.startsWith(executable + " ")) continue
    rows.push({ pid: Number(pid), created, executable, command, managedTag: tagOf(command, flag), port: portOf(command) })
  }
  return rows
}

export function verifiedForStop(row, current, flag) {
  return !!current && current.pid === row.pid && current.created === row.created && current.executable === row.executable &&
    managedPattern.test(row.managedTag ?? "") && hasTag(current.command, flag, row.managedTag)
}

export function posixProcessDependencies(flag, { execFile: run = execute, spawnSync: runSync = spawnSync, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const env = { ...process.env, LC_ALL: "C", LANG: "C" }
  let executable
  return {
    setExecutable(value) { executable = value },
    async processes() {
      if (!executable) return []
      const { stdout } = await run("ps", ["-axww", "-o", "pid=,lstart=,command="], { timeout: 5000, env, maxBuffer: 16 << 20 })
      return parsePs(stdout, executable, flag)
    },
    parentAlive(pid) { try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" } },
    async stopManaged(row) {
      const { stdout } = await run("ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", String(row.pid)], { timeout: 5000, env }).catch(() => ({ stdout: "" }))
      const current = parsePs(stdout, row.executable, flag)[0]
      if (verifiedForStop(row, current, flag)) kill(row.pid, "SIGTERM")
    },
    stopManagedSync(row) {
      const result = runSync("ps", ["-ww", "-o", "pid=,lstart=,command=", "-p", String(row.pid)], { timeout: 5000, env, encoding: "utf8" })
      const current = parsePs(result?.stdout ?? "", row.executable, flag)[0]
      if (verifiedForStop(row, current, flag)) { try { kill(row.pid, "SIGTERM") } catch {} }
    },
  }
}

export const PROCESS_PROJECTION = "Select-Object ProcessId,CommandLine,ExecutablePath,@{Name='CreationDate';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}"
export function stopScript(flag) {
  return `$expected = [Console]::In.ReadToEnd() | ConvertFrom-Json; $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($expected.pid)"; if ($process -and $process.ExecutablePath -eq $expected.executable -and $process.CreationDate.ToUniversalTime().Ticks.ToString() -ceq $expected.created -and $expected.managedTag -cmatch '^[1-9][0-9]*:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -and $process.CommandLine -cmatch ('(?:^|\\s)--${flag}=' + [regex]::Escape($expected.managedTag) + '(?=\\s|$)')) { Invoke-CimMethod -InputObject $process -MethodName Terminate | Out-Null }`
}
export function windowsProcessDependencies(name, flag) {
  return {
    setExecutable() {},
    async processes() {
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `@(Get-CimInstance Win32_Process -Filter "Name='${name}'" | ${PROCESS_PROJECTION}) | ConvertTo-Json -Compress`], { windowsHide: true, timeout: 5000 })
      const rows = JSON.parse(stdout || "[]")
      return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, executable: row.ExecutablePath, created: row.CreationDate, managedTag: tagOf(row.CommandLine, flag), port: portOf(row.CommandLine) }))
    },
    parentAlive(pid) { try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" } },
    async stopManaged(row) {
      await new Promise((resolve, reject) => {
        const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopScript(flag)], { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve())
        child.stdin.end(JSON.stringify(row))
      })
    },
    stopManagedSync(row) {
      spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", stopScript(flag)], { input: JSON.stringify(row), windowsHide: true, timeout: 5000, stdio: ["pipe", "ignore", "ignore"] })
    },
  }
}

export function processDependencies(flag, platform = process.platform) {
  return platform === "win32" ? windowsProcessDependencies(`${APP_NAME}.exe`, flag) : posixProcessDependencies(flag)
}
