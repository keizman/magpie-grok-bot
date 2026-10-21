// Behavioral pins for scripts/check.mjs. Each test copies the repository into a
// temporary fixture tree, optionally replaces one module, and runs the fixture's
// copy of the gate with --stubs, so no app, sign-in, network call or credential
// is reached. No test writes into the repository.

import { afterEach, expect, test } from "bun:test"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const fixtureDirs = []
const GATE_ENV = { ...process.env, PATH: "/nonexistent", ProgramFiles: "Z:\\missing", LOCALAPPDATA: "Z:\\missing", HOME: "/nonexistent-home" }

async function buildFixtureTree(replacements = {}) {
  const dir = await mkdtemp(join(tmpdir(), "gate-pin-"))
  fixtureDirs.push(dir)
  for (const entry of ["index.mjs", "package.json", "lib", "providers", "scripts"]) await cp(join(repoRoot, entry), join(dir, entry), { recursive: true })
  for (const [relativePath, content] of Object.entries(replacements)) await writeFile(join(dir, relativePath), content)
  return dir
}
function runGate(dir) {
  const result = spawnSync(process.execPath, ["scripts/check.mjs", "--stubs"], { cwd: dir, encoding: "utf8", env: GATE_ENV, timeout: 120_000 })
  return { status: result.status, output: (result.stdout ?? "") + (result.stderr ?? "") }
}

afterEach(async () => { while (fixtureDirs.length) await rm(fixtureDirs.pop(), { recursive: true, force: true }) })

test("the real tree passes the sandboxed gate without touching the app", async () => {
  const { status, output } = runGate(await buildFixtureTree())
  expect(status).toBe(0)
  expect(output).toContain("implemented: grok-bot; app operations: 0")
  expect(output).toContain("sandbox summary: external operations: 0")
  expect(output).toContain("✓ magpie-grok-bot (1 provider: grok-bot)")
})

test("an exported helper is rejected because the host would invoke it as a plugin", async () => {
  const index = `export { GrokBotPlugin, _internal } from "./index.real.mjs"\nexport function helper() {}\n`
  const dir = await buildFixtureTree({ "index.mjs": index })
  await cp(join(repoRoot, "index.mjs"), join(dir, "index.real.mjs"))
  const { status, output } = runGate(dir)
  expect(status).not.toBe(0)
  expect(output).toContain("unexpected export: helper")
})

test("grok-bot OAuth methods must keep their sandbox shape: malformed OAuth flow", async () => {
  const source = `import { makeGrokBotDriver as real } from "./grok-bot.real.mjs"
export function makeGrokBotDriver(...args) {
  const driver = real(...args)
  driver.auth.methods[0] = { ...driver.auth.methods[0], authorize: args => args?.env === "sandbox" ? { method: "not-auto" } : driver.auth.methods[1].authorize() }
  return driver
}
`
  const dir = await buildFixtureTree({ "providers/grok-bot.mjs": source })
  await cp(join(repoRoot, "providers/grok-bot.mjs"), join(dir, "providers/grok-bot.real.mjs"))
  const { status, output } = runGate(dir)
  expect(status).not.toBe(0)
  expect(output).toContain("GrokBotPlugin: Error: malformed OAuth flow")
})

test("a transport that reaches outside the sandbox fails the gate", async () => {
  const source = `import { makeGrokBotDriver as real } from "./grok-bot.real.mjs"
export function makeGrokBotDriver(...args) {
  const driver = real(...args)
  const config = driver.config
  driver.config = async cfg => { try { await globalThis.fetch("https://sentinel-blocked.invalid") } catch {} return config(cfg) }
  return driver
}
`
  const dir = await buildFixtureTree({ "providers/grok-bot.mjs": source })
  await cp(join(repoRoot, "providers/grok-bot.mjs"), join(dir, "providers/grok-bot.real.mjs"))
  const { status, output } = runGate(dir)
  expect(status).not.toBe(0)
  expect(output).toContain("sandbox isolation failed: 1 external operations")
})
