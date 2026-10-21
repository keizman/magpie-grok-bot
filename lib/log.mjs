export function debug(provider, event) {
  const flag = process.env.MAGPIE_GROK_BOT_DEBUG ?? process.env.MAGPIE_CLOUD_AGENTS_DEBUG
  if (!/^(1|true|yes|on)$/i.test(flag?.trim() ?? "")) return
  try { console.error(`[magpie-grok-bot] ${provider}: ${event}`) } catch {}
}
