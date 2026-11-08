/**
 * Host half: the retention engine, its fenced routes, and the periodic tick.
 *
 * Nothing in the harness deletes a Session, so this plugin owns the filesystem
 * work and therefore owns the safety perimeter around it. The pieces:
 *
 * * `sweep.ts` — the guarded two-stage engine (move into trash, purge past grace).
 * * `routes.ts` — the three fenced `/api` routes the page drives.
 * * this module — wiring, and the schedule.
 *
 * Scheduling is a global `setInterval` plus a one-shot `setTimeout` after a short
 * boot delay, both `unref`ed and both cleared in one `ctx.effect` disposer;
 * `ctx.setInterval` does not exist at this baseline. Each tick re-reads the
 * volatile config, so a settings save changes the interval, the window, and the
 * dry-run switch without a restart and without re-registering the timer.
 *
 * `dryRun: true` gates AUTOMATIC runs only: an automatic tick with dry run on
 * records a preview report and moves nothing, while the page's explicit
 * "Delete now" still works — that click is the operator's approval, and the
 * preview it must present is what bounds it.
 *
 * @module dsh-session-retention
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.connection` service merge and its fenced-route registry.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: pulls the `ctx.agents` service merge (the live-Session guard).
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls `ctx.sessions`, the Session id vocabulary, and the artifact layout.
import type {} from '@deepseek-ai/dsh-session'
// Type-only: pulls the `ctx.sessionPersistence` service merge.
import type {} from '@deepseek-ai/dsh-session-persistence'
// Type-only: pulls `ctx.workspaceRegistry` and the `workspace/session-activity` waterfall.
import type {} from '@deepseek-ai/dsh-workspace'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

import { registerFencedRoutes } from './routes.ts'
import type { RouteConfig } from './routes.ts'
import { Config } from './schema.ts'
import { RetentionSweep } from './sweep.ts'

export { Config } from './schema.ts'

/** Loader id of this plugin; it equals the package name and the settings namespace. */
export const name = 'dsh-session-retention'

/**
 * Services this half reads. All five are present in the `web` profile; the fenced
 * `connection` channel is the only browser-reachable surface.
 */
export const inject = ['connection', 'sessionPersistence', 'workspaceRegistry', 'sessions', 'agents']

/** How often a tick checks whether a sweep is due. */
const TICK_MS = 60_000

/** Delay before the first tick, so boot is not competing with a large directory scan. */
const BOOT_DELAY_MS = 30_000

/**
 * Apply the retention policy: register the fenced routes and start the tick.
 * @param ctx - Host context owning the five injected services.
 * @param config - Validated live configuration; each field is a live reference.
 */
export function apply(ctx: Context, config: Config): void {
  const readConfig = (): RouteConfig => ({
    autoSweep: config.autoSweep?.get() ?? true,
    retentionDays: config.retentionDays?.get() ?? 30,
    sweepIntervalHours: config.sweepIntervalHours?.get() ?? 24,
    dryRun: config.dryRun?.get() ?? true,
    trashGraceDays: config.trashGraceDays?.get() ?? 7,
    maxMovesPerRun: config.maxMovesPerRun?.get() ?? 500,
  })

  const engine = new RetentionSweep({
    listSnapshots: async () => await ctx.sessionPersistence.list(),
    openWrite: async sessionId => await ctx.sessionPersistence.open(sessionId, 'write'),
    pinnedIds: () => ctx.workspaceRegistry.pinnedSessionIds,
    isLive: sessionId => ctx.agents.get(sessionId) !== undefined || ctx.sessions.get(sessionId) !== undefined,
    hasActivity: async sessionId => (
      await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
    ).length > 0,
    unarchive: async sessionId => { await ctx.workspaceRegistry.unarchiveSession(sessionId) },
    log: message => { ctx.logger.debug(message) },
    sessionsRoot: dshHomePath('sessions'),
    // Inside the config home's already-ignored `cache/`: `$DSH_HOME` is the working
    // tree of the PUBLIC profile repository, so trash must never be a new
    // unignored path there.
    trashRoot: dshHomePath('cache', 'session-trash'),
  })

  registerFencedRoutes(ctx, { engine, config: readConfig })

  let lastRun = 0
  let ticking = false
  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      const live = readConfig()
      if (!live.autoSweep) return
      const intervalMs = Math.max(1, Math.trunc(live.sweepIntervalHours)) * 3_600_000
      if (Date.now() - lastRun < intervalMs) return
      lastRun = Date.now()
      const report = await engine.sweep(
        { retentionDays: live.retentionDays, dryRun: live.dryRun, trashGraceDays: live.trashGraceDays, maxMovesPerRun: live.maxMovesPerRun },
        { mode: live.dryRun ? 'preview' : 'sweep' },
      )
      ctx.logger.info(
        `dsh-session-retention: automatic ${report.mode} reviewed=${String(report.reviewed)} `
        + `moved=${String(report.moved)} purged=${String(report.purged)} remaining=${String(report.remaining)}`,
      )
    } catch (error) {
      // A busy engine means a page request already owns the run; anything else is
      // worth a warning, and neither may take the Host down.
      const busy = error instanceof Error && error.name === 'SweepBusyError'
      const line = `dsh-session-retention: automatic sweep failed: ${error instanceof Error ? error.message : String(error)}`
      if (busy) ctx.logger.debug(line)
      else ctx.logger.warn(line)
    } finally {
      ticking = false
    }
  }

  ctx.effect(() => {
    const interval = setInterval(() => { void tick() }, TICK_MS)
    interval.unref?.()
    const first = setTimeout(() => { void tick() }, BOOT_DELAY_MS)
    first.unref?.()
    return () => {
      clearInterval(interval)
      clearTimeout(first)
    }
  }, 'dsh-session-retention: scheduler')
}
