import { expect, test } from "bun:test"
import { bundleExecutable, findExecutable, magpieDir, managedProfileDir, ownsRow, parsePs, posixProcessDependencies, processDependencies, profileOf, samePath, stateDir, verifiedForStop } from "./platform.mjs"

const xmlPlist = name => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>Grok Bot</string>
  <key>CFBundleExecutable</key>
  <string>${name}</string>
  <key>CFBundleIdentifier</key><string>com.anysphere.sand</string>
</dict></plist>`
const mac = (files, extra = {}) => ({
  platform: "darwin", env: { HOME: "/Users/tester" },
  exists: async path => path in files,
  readFile: async path => { if (typeof files[path] !== "string" && !Buffer.isBuffer(files[path])) throw new Error("ENOENT"); return files[path] },
  ...extra,
})
const SYSTEM = "/Applications/Grok Bot.app"
const USER = "/Users/tester/Applications/Grok Bot.app"

test("macOS: finds /Applications and reads the executable name from an XML Info.plist", async () => {
  const deps = mac({ [SYSTEM]: true, [`${SYSTEM}/Contents/Info.plist`]: xmlPlist("Grok Bot"), [`${SYSTEM}/Contents/MacOS/Grok Bot`]: true })
  expect(await findExecutable(deps)).toBe(`${SYSTEM}/Contents/MacOS/Grok Bot`)
})

test("macOS: a renamed bundle executable is honoured", async () => {
  const deps = mac({ [SYSTEM]: true, [`${SYSTEM}/Contents/Info.plist`]: xmlPlist("Sand &amp; Co"), [`${SYSTEM}/Contents/MacOS/Sand & Co`]: true })
  expect(await findExecutable(deps)).toBe(`${SYSTEM}/Contents/MacOS/Sand & Co`)
})

test("macOS: a binary Info.plist is converted with plutil", async () => {
  const calls = []
  const deps = mac({ [SYSTEM]: true, [`${SYSTEM}/Contents/Info.plist`]: Buffer.from("bplist00\u0000\u0001binary"), [`${SYSTEM}/Contents/MacOS/Grok Bot`]: true }, {
    execFile: async (command, args) => { calls.push([command, ...args]); return { stdout: JSON.stringify({ CFBundleExecutable: "Grok Bot" }) } },
  })
  expect(await findExecutable(deps)).toBe(`${SYSTEM}/Contents/MacOS/Grok Bot`)
  expect(calls).toEqual([["/usr/bin/plutil", "-convert", "json", "-o", "-", `${SYSTEM}/Contents/Info.plist`]])
})

test("macOS: falls back to ~/Applications when /Applications has no bundle", async () => {
  const deps = mac({ [USER]: true, [`${USER}/Contents/Info.plist`]: xmlPlist("Grok Bot"), [`${USER}/Contents/MacOS/Grok Bot`]: true })
  expect(await findExecutable(deps)).toBe(`${USER}/Contents/MacOS/Grok Bot`)
})

test("macOS: grokBot.appPath takes precedence as a bundle or as an executable", async () => {
  const custom = "/Volumes/Apps/Grok Bot Beta.app"
  const files = { [SYSTEM]: true, [`${SYSTEM}/Contents/Info.plist`]: xmlPlist("Grok Bot"), [`${SYSTEM}/Contents/MacOS/Grok Bot`]: true, [custom]: true, [`${custom}/Contents/Info.plist`]: xmlPlist("Grok Bot Beta"), [`${custom}/Contents/MacOS/Grok Bot Beta`]: true, "/opt/grok": true }
  expect(await findExecutable(mac(files), { appPath: custom + "/" })).toBe(`${custom}/Contents/MacOS/Grok Bot Beta`)
  expect(await findExecutable(mac(files), { appPath: "/opt/grok" })).toBe("/opt/grok")
})

test("macOS: a missing app or a bundle without its executable is not found", async () => {
  expect(await findExecutable(mac({}))).toBeNull()
  expect(await findExecutable(mac({ [SYSTEM]: true, [`${SYSTEM}/Contents/Info.plist`]: xmlPlist("Grok Bot") }))).toBeNull()
})

test("macOS: an unreadable or hostile plist name falls back to the app name", async () => {
  expect(await bundleExecutable(SYSTEM, mac({}))).toBeNull()
  expect(await bundleExecutable(SYSTEM, mac({ [`${SYSTEM}/Contents/Info.plist`]: xmlPlist("../../bin/sh") }))).toBeNull()
  const deps = mac({ [SYSTEM]: true, [`${SYSTEM}/Contents/Info.plist`]: xmlPlist("../../bin/sh"), [`${SYSTEM}/Contents/MacOS/Grok Bot`]: true })
  expect(await findExecutable(deps)).toBe(`${SYSTEM}/Contents/MacOS/Grok Bot`)
})

test("Windows: ProgramFiles, LOCALAPPDATA, then PATH in order", async () => {
  const visited = []
  const found = await findExecutable({ platform: "win32", env: { ProgramFiles: "C:\\Global", LOCALAPPDATA: "C:\\Local", PATH: "C:\\Tools;C:\\More" }, exists: async path => { visited.push(path); return path === "C:\\Tools\\Grok Bot.exe" } })
  expect(visited).toEqual(["C:\\Global\\Grok Bot\\Grok Bot.exe", "C:\\Local\\Programs\\Grok Bot\\Grok Bot.exe", "C:\\Tools\\Grok Bot.exe"])
  expect(found).toBe("C:\\Tools\\Grok Bot.exe")
})

test("profile and state folders follow each platform's conventions", () => {
  expect(magpieDir({ platform: "darwin", env: { HOME: "/Users/t" } })).toBe("/Users/t/Library/Application Support/Magpie")
  expect(managedProfileDir({ platform: "darwin", env: { HOME: "/Users/t" } })).toBe("/Users/t/Library/Application Support/Magpie/grok-bot-managed-profile")
  expect(stateDir({ platform: "darwin", env: { HOME: "/Users/t" } })).toBe("/Users/t/Library/Application Support/Magpie/grok-bot")
  expect(managedProfileDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Local" } })).toBe("C:\\Local\\Magpie\\grok-bot-managed-profile")
  expect(stateDir({ platform: "linux", env: { HOME: "/home/t" } })).toBe("/home/t/.local/state/magpie/grok-bot")
  expect(managedProfileDir({ platform: "darwin", env: { HOME: "/Users/t" } }, { profileDir: "/tmp/p" })).toBe("/tmp/p")
})

test("paths compare case-insensitively only on Windows", () => {
  expect(samePath("C:\\A.exe", "c:\\a.exe", "win32")).toBe(true)
  expect(samePath("/Applications/A", "/applications/a", "darwin")).toBe(false)
  expect(samePath("/a", "/a", "darwin")).toBe(true)
})

const EXE = "/Applications/Grok Bot.app/Contents/MacOS/Grok Bot"
const TAG = "4242:12345678-1234-4234-8234-123456789abc"
const PS = [
  `  501 Tue Oct 20 18:14:58 2026     ${EXE}`,
  `  777 Wed Oct  1 09:01:02 2026     ${EXE} --remote-debugging-port=9333 --remote-debugging-address=127.0.0.1 --magpie-grok-managed=${TAG} --user-data-dir=/Users/t/Library/Application Support/Magpie/grok-bot-managed-profile`,
  `  778 Wed Oct 21 09:01:03 2026     ${EXE} --relaunch`,
  `  779 Wed Oct 21 09:01:03 2026     /Applications/Grok Bot.app/Contents/Frameworks/Grok Bot Helper.app/Contents/MacOS/Grok Bot Helper --type=gpu-process`,
  `  780 Wed Oct 21 09:01:04 2026     /usr/bin/vim notes.txt`,
].join("\n")

test("ps parsing keeps main app processes with their start time, tag and port", () => {
  const rows = parsePs(PS, EXE, "magpie-grok-managed")
  expect(rows.map(row => row.pid)).toEqual([501, 777, 778])
  expect(rows[0]).toMatchObject({ pid: 501, created: "Tue Oct 20 18:14:58 2026", executable: EXE, managedTag: undefined, port: undefined })
  expect(rows[1]).toMatchObject({ pid: 777, created: "Wed Oct  1 09:01:02 2026", managedTag: TAG, port: 9333 })
})

test("stop is identity-checked: pid, start time, executable and managed tag must all match", () => {
  const [, managed] = parsePs(PS, EXE, "magpie-grok-managed")
  expect(verifiedForStop(managed, { ...managed }, "magpie-grok-managed")).toBe(true)
  expect(verifiedForStop(managed, { ...managed, created: "Wed Oct  1 09:01:03 2026" }, "magpie-grok-managed")).toBe(false)
  expect(verifiedForStop(managed, { ...managed, executable: "/tmp/other" }, "magpie-grok-managed")).toBe(false)
  expect(verifiedForStop(managed, { ...managed, command: EXE }, "magpie-grok-managed")).toBe(false)
  expect(verifiedForStop({ ...managed, managedTag: "probe" }, { ...managed, command: `${EXE} --magpie-grok-managed=probe` }, "magpie-grok-managed")).toBe(false)
  expect(verifiedForStop(managed, undefined, "magpie-grok-managed")).toBe(false)
})

test("POSIX process tools list with ps and stop with SIGTERM only after re-verifying", async () => {
  const calls = [], kills = []
  let current = PS
  const deps = posixProcessDependencies("magpie-grok-managed", {
    execFile: async (command, args, options) => { calls.push({ command, args, env: options.env }); return { stdout: args.includes("-p") ? current.split("\n").find(line => line.includes(` ${args.at(-1)} `)) ?? "" : current } },
    spawnSync: (command, args) => ({ stdout: current.split("\n").find(line => line.includes(` ${args.at(-1)} `)) ?? "" }),
    kill: (pid, signal) => kills.push([pid, signal]),
  })
  expect(await deps.processes()).toEqual([])
  deps.setExecutable(EXE)
  const rows = await deps.processes()
  expect(calls[0]).toMatchObject({ command: "ps", args: ["-axww", "-o", "pid=,lstart=,command="] })
  expect(calls[0].env.LC_ALL).toBe("C")
  const managed = rows.find(row => row.managedTag)
  await deps.stopManaged(managed)
  deps.stopManagedSync(managed)
  expect(kills).toEqual([[777, "SIGTERM"], [777, "SIGTERM"]])
  await deps.stopManaged(rows.find(row => row.pid === 501))
  current = PS.replace("Wed Oct  1 09:01:02 2026", "Wed Oct  1 09:30:00 2026")
  await deps.stopManaged(managed)
  expect(kills).toHaveLength(2)
})

test("profile ownership separates the user's app from Magpie's managed window", () => {
  const managedDir = "/Users/t/Library/Application Support/Magpie/grok-bot-managed-profile"
  const rows = parsePs(PS, EXE, "magpie-grok-managed")
  expect(profileOf(rows[1].command)).toBe(managedDir)
  expect(rows.filter(row => ownsRow(row, { shared: true, profileDir: managedDir, platform: "darwin" })).map(row => row.pid)).toEqual([501, 778])
  expect(rows.filter(row => ownsRow(row, { shared: false, profileDir: managedDir, platform: "darwin" })).map(row => row.pid)).toEqual([777])
  expect(ownsRow({ command: `${EXE} --type=renderer` }, { shared: true })).toBe(false)
  const windows = `"C:\\Program Files\\Grok Bot\\Grok Bot.exe" "--user-data-dir=C:\\Users\\t\\AppData\\Local\\Magpie\\grok-bot-managed-profile" --disable-renderer-backgrounding`
  expect(profileOf(windows)).toBe("C:\\Users\\t\\AppData\\Local\\Magpie\\grok-bot-managed-profile")
  expect(ownsRow({ command: windows }, { shared: false, profileDir: "c:\\users\\t\\appdata\\local\\magpie\\grok-bot-managed-profile", platform: "win32" })).toBe(true)
})

test("POSIX stopApp re-verifies pid and start time before sending SIGTERM", async () => {
  const kills = []
  let current = PS
  const deps = posixProcessDependencies("magpie-grok-managed", {
    execFile: async (command, args) => ({ stdout: current.split("\n").find(line => line.includes(` ${args.at(-1)} `)) ?? "" }),
    kill: (pid, signal) => kills.push([pid, signal]),
  })
  const [user] = parsePs(PS, EXE, "magpie-grok-managed")
  await deps.stopApp(user)
  expect(kills).toEqual([[501, "SIGTERM"]])
  current = PS.replace("Tue Oct 20 18:14:58 2026", "Tue Oct 20 19:00:00 2026")
  await deps.stopApp(user)
  expect(kills).toHaveLength(1)
})

test("process tools are chosen by platform", () => {
  expect(typeof processDependencies("magpie-grok-managed", "darwin").setExecutable).toBe("function")
  expect(typeof processDependencies("magpie-grok-managed", "win32").stopManagedSync).toBe("function")
})
