/**
 * Plugin entry configuration schema (schemastery).
 *
 * Every field is VOLATILE because the Plugins panel's configuration page writes
 * through the settings service, and that write gate refuses a non-volatile field
 * (`Config field ... is not volatile`). The periodic tick re-reads the live
 * references at the moment of use, so a save changes behaviour without a restart
 * and without re-registering the timer.
 *
 * The defaults ARE the shipped retention policy: a 30-day window, a daily tick,
 * the destructive automatic sweep DISARMED (`dryRun: true`), a 7-day trash grace
 * window, and at most 500 moves per request or tick. They are stated a second
 * time in `cordis.patch.yml` so `--dump-config` shows the policy a profile runs;
 * a field absent from the profile patch falls back to these values.
 *
 * @module dsh-session-retention/schema
 */

import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Live plugin entry configuration. */
export interface Config {
  /** Whether the periodic tick sweeps at all; `false` leaves only the page's own controls. */
  readonly autoSweep?: Volatile<boolean>
  /** Age threshold in days: a Session with no durable activity for this long is a candidate. */
  readonly retentionDays?: Volatile<number>
  /** Minimum gap between two automatic sweeps, in hours. */
  readonly sweepIntervalHours?: Volatile<number>
  /** Whether an automatic sweep only reports candidates (`true`) or also moves them to the trash. */
  readonly dryRun?: Volatile<boolean>
  /** Hours a moved Session stays restorable in the trash before the purge reclaims it (0 = next tick). */
  readonly trashGraceDays?: Volatile<number>
  /** Upper bound on moves in one request or one tick. */
  readonly maxMovesPerRun?: Volatile<number>
}

/** The plugin entry schema. */
export const Config = z.object({
  autoSweep: z.boolean().default(true).volatile(),
  retentionDays: z.number().min(1).max(3650).default(30).volatile(),
  sweepIntervalHours: z.number().min(1).max(168).default(24).volatile(),
  dryRun: z.boolean().default(true).volatile(),
  trashGraceDays: z.number().min(0).max(365).default(7).volatile(),
  maxMovesPerRun: z.number().min(1).max(5000).default(500).volatile(),
})
