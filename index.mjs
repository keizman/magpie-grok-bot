import { makeGrokBotDriver } from "./providers/grok-bot.mjs"

import { debug } from "./lib/log.mjs"

function validateOptions(options) {
  const invalid = (path, expected) => { throw new TypeError(`Invalid plugin configuration: ${path} must be ${expected}`) }
  const object = (value, path) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "an object")
  }
  const number = (value, path, zero = false, integer = false) => {
    if (!Number.isFinite(value) || (zero ? value < 0 : value <= 0) || (integer && !Number.isSafeInteger(value))) invalid(path, `${zero ? "a non-negative" : "a positive"}${integer ? " integer" : " finite number"}`)
  }
  const text = (value, path) => { if (typeof value !== "string" || !value.trim()) invalid(path, "a non-empty string") }
  const boolean = (value, path) => { if (value != null && typeof value !== "boolean") invalid(path, "a boolean") }
  object(options, "options")
  boolean(options.progress, "progress")
  if (options.maxRunMinutes != null) number(options.maxRunMinutes, "maxRunMinutes")
  if (options.maxPromptBytes != null) number(options.maxPromptBytes, "maxPromptBytes", false, true)
  if (options.grokBot == null) return
  object(options.grokBot, "grokBot")
  const settings = options.grokBot
  for (const key of ["keepAliveMinutes", "launchTimeoutMs", "appBootMs", "settleMs", "stuckMs", "emptyMs", "sentMs", "selectMs", "quitTimeoutMs", "botsMs"]) {
    if (settings[key] != null) number(settings[key], `grokBot.${key}`, true)
  }
  if (settings.streamPollMs != null) number(settings.streamPollMs, "grokBot.streamPollMs")
  if (settings.reattachPorts != null && (!Array.isArray(settings.reattachPorts) || settings.reattachPorts.some(port => !Number.isInteger(port) || port < 1 || port > 65535))) invalid("grokBot.reattachPorts", "an array of ports from 1 to 65535")
  for (const key of ["ghostMode", "bringToFront", "sessionHeader", "persistSessions", "restartApp"]) boolean(settings[key], `grokBot.${key}`)
  if (settings.profile != null && !["app", "managed"].includes(settings.profile)) invalid("grokBot.profile", `"app" or "managed"`)
  for (const key of ["appPath", "stateDir", "profileDir"]) if (settings[key] != null) text(settings[key], `grokBot.${key}`)
  if (settings.systemPrompt != null && !["first", "never"].includes(settings.systemPrompt)) invalid("grokBot.systemPrompt", `"first" or "never"`)
  if (settings.selectors != null) {
    object(settings.selectors, "grokBot.selectors")
    for (const [key, value] of Object.entries(settings.selectors)) if (value != null) text(value, `grokBot.selectors.${key}`)
  }
}

async function initialize(provider, options, factory) {
  debug(provider, "startup")
  try {
    const settings = options ?? {}
    validateOptions(settings)
    return await factory(settings)
  } catch (error) {
    // Errors can contain prompts; log only the lifecycle event.
    debug(provider, "startup failed")
    throw error
  }
}

export async function GrokBotPlugin(input, options) { return initialize("grok-bot", options, settings => makeGrokBotDriver(input, settings)) }

export const _internal = {}
