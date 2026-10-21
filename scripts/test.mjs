// Runs the test suite. Direct Connect is Windows-only (it loads crypt32.dll through
// bun:ffi), so its tests run only on Windows; everything else runs everywhere.
import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const WINDOWS_ONLY = new Set(["providers/grok-bot-direct.test.mjs"])
const files = []
for (const folder of ["lib", "providers", "scripts"]) {
  for (const name of readdirSync(join(root, folder))) {
    const file = relative(root, join(root, folder, name)).split("\\").join("/")
    if (!file.endsWith(".test.mjs")) continue
    if (WINDOWS_ONLY.has(file) && process.platform !== "win32") { console.log(`skipping ${file} (Windows only)`); continue }
    files.push("./" + file)
  }
}
const result = spawnSync(process.execPath, ["test", ...files, ...process.argv.slice(2)], { cwd: root, stdio: "inherit" })
process.exit(result.status ?? 1)
