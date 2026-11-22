/** Dev/test env hooks (fake folder picker, permission mode, ...) are ignored when NODE_ENV is production. */
export function devEnv(name: string): string | undefined {
  return process.env['NODE_ENV'] === 'production' ? undefined : process.env[name]
}

/**
 * ZUMIBOT_CLAUDE_SDK=1: a Claude turn spawns through the Claude Agent SDK adapter instead of the CLI runner, so the two can
 * run side by side (see docs/architecture/engines.md). Anything else is off, and so is everything under NODE_ENV=production,
 * which is what the packaged desktop sets.
 */
export const claudeSdkEngineOn = (raw = devEnv('ZUMIBOT_CLAUDE_SDK')): boolean => raw === '1'

/**
 * ZUMIBOT_TEST_WAIT_SCALE: what a workflow Wait's minutes are divided by, so e2e:workflows can wait 1 minute in about
 * 1 second (60). Anything but a number of at least 1 is 1, and so is everything under NODE_ENV=production.
 */
export function testWaitScale(raw = devEnv('ZUMIBOT_TEST_WAIT_SCALE')): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 1 ? n : 1
}

/**
 * ZUMIBOT_AGUI_ALLOW_LOCAL=1: a remote (AG-UI) agent may reach a loopback or private address, and plain http to loopback, so
 * the fake server and the e2e suite can serve one (docs/architecture/protocol-engines.md, Endpoint checks). Anything else is
 * off, and so is everything under NODE_ENV=production.
 */
export const aguiAllowLocal = (raw = devEnv('ZUMIBOT_AGUI_ALLOW_LOCAL')): boolean => raw === '1'
