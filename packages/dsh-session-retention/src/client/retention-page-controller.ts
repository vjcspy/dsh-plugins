/**
 * The page's draft model: what the Host says, what the operator typed, and the
 * operations that carry one into the other.
 *
 * The page owns no write path of its own. It renders the snapshot the Plugins
 * panel hands it (`form.state`) — the schema-resolved values, the raw user layer
 * whose PRESENCE marks a field overridden, and the revision that fences the next
 * write — and it submits every edit through `form.mutate` in one atomic call.
 * Nothing here performs I/O, so the whole draft can be reasoned about and
 * exercised without a browser.
 *
 * Validation is deliberately local and strict. The Host validates again; this half
 * only refuses to SEND a value the schema would reject, so a refused write is a
 * Host decision (revision fence, stale document) and never a client typo.
 *
 * @module dsh-session-retention/client/retention-page-controller
 */

/** The six policy fields, in display order. */
export const FIELD_KEYS = [
  'autoSweep', 'retentionDays', 'sweepIntervalHours', 'dryRun', 'trashGraceDays', 'maxMovesPerRun',
] as const

/** One policy field. */
export type FieldKey = typeof FIELD_KEYS[number]

/** The policy as the Host resolves it, with every field present. */
export interface RetentionSettings {
  /** Whether the periodic tick sweeps at all. */
  readonly autoSweep: boolean
  /** Age threshold in days. */
  readonly retentionDays: number
  /** Minimum gap between automatic sweeps, in hours. */
  readonly sweepIntervalHours: number
  /** Whether an automatic sweep only previews. */
  readonly dryRun: boolean
  /** Hours a moved Session stays restorable. */
  readonly trashGraceDays: number
  /** Upper bound on moves per run. */
  readonly maxMovesPerRun: number
}

/** The policy the plugin ships with; also the fallback for a value the Host omits. */
export const DEFAULT_SETTINGS: RetentionSettings = {
  autoSweep: true,
  retentionDays: 30,
  sweepIntervalHours: 24,
  dryRun: true,
  trashGraceDays: 7,
  maxMovesPerRun: 500,
}

/** Inclusive bounds of the four numeric fields, mirroring the Host schema. */
export const NUMERIC_BOUNDS: Readonly<Record<'retentionDays' | 'sweepIntervalHours' | 'trashGraceDays' | 'maxMovesPerRun', { readonly min: number; readonly max: number }>> = {
  retentionDays: { min: 1, max: 3650 },
  sweepIntervalHours: { min: 1, max: 168 },
  trashGraceDays: { min: 0, max: 365 },
  maxMovesPerRun: { min: 1, max: 5000 },
}

/** The operator's staged text, one entry per field. */
export type RetentionDraft = Record<FieldKey, string>

/**
 * One atomic field operation, spelled structurally so this half needs no
 * dependency on the Host settings package.
 */
export type RetentionPathOp =
  | { readonly op: 'set'; readonly path: string[]; readonly value: boolean | number }
  | { readonly op: 'unset'; readonly path: string[] }

/** Whether a key names a numeric field. */
function isNumericField(key: FieldKey): key is 'retentionDays' | 'sweepIntervalHours' | 'trashGraceDays' | 'maxMovesPerRun' {
  return key !== 'autoSweep' && key !== 'dryRun'
}

/** Read a boolean field, falling back to the shipped default. */
function booleanOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Read a numeric field, falling back to the shipped default when it is not a finite number. */
function numberOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Resolve the Host snapshot into the six fields the page edits.
 * @param value - `form.state.value`, absent before the first accepted section.
 * @returns every field, with shipped defaults for anything missing.
 */
export function settingsFrom(value: Record<string, unknown> | undefined): RetentionSettings {
  return {
    autoSweep: booleanOf(value?.autoSweep, DEFAULT_SETTINGS.autoSweep),
    retentionDays: numberOf(value?.retentionDays, DEFAULT_SETTINGS.retentionDays),
    sweepIntervalHours: numberOf(value?.sweepIntervalHours, DEFAULT_SETTINGS.sweepIntervalHours),
    dryRun: booleanOf(value?.dryRun, DEFAULT_SETTINGS.dryRun),
    trashGraceDays: numberOf(value?.trashGraceDays, DEFAULT_SETTINGS.trashGraceDays),
    maxMovesPerRun: numberOf(value?.maxMovesPerRun, DEFAULT_SETTINGS.maxMovesPerRun),
  }
}

/**
 * Which fields the user layer overrides.
 *
 * Presence in the raw user layer is the signal, not value equality: an override
 * that happens to equal the composition value is still an override, and only
 * clearing it restores inheritance.
 * @param user - `form.state.user`.
 * @returns the overridden field names.
 */
export function overriddenFields(user: unknown): ReadonlySet<FieldKey> {
  if (typeof user !== 'object' || user === null) return new Set<FieldKey>()
  return new Set(FIELD_KEYS.filter(key => Object.hasOwn(user, key)))
}

/**
 * Render the resolved policy as the draft text its controls show.
 * @param settings - the resolved policy.
 * @returns one string per field.
 */
export function draftFrom(settings: RetentionSettings): RetentionDraft {
  return {
    autoSweep: settings.autoSweep ? 'true' : 'false',
    retentionDays: String(settings.retentionDays),
    sweepIntervalHours: String(settings.sweepIntervalHours),
    dryRun: settings.dryRun ? 'true' : 'false',
    trashGraceDays: String(settings.trashGraceDays),
    maxMovesPerRun: String(settings.maxMovesPerRun),
  }
}

/** The whole-number form a numeric field accepts, or undefined. */
function wholeNumberOf(text: string, key: FieldKey): number | undefined {
  if (!isNumericField(key)) return undefined
  const trimmed = text.trim()
  if (!/^\d+$/.test(trimmed)) return undefined
  const parsed = Number(trimmed)
  const bounds = NUMERIC_BOUNDS[key]
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) return undefined
  return parsed
}

/**
 * Which staged fields a save would refuse.
 * @param draft - the staged text.
 * @returns the invalid field names; empty means the draft can be submitted.
 */
export function invalidFields(draft: RetentionDraft): ReadonlySet<FieldKey> {
  const invalid = new Set<FieldKey>()
  for (const key of FIELD_KEYS) {
    const text = draft[key].trim()
    // An empty string is not invalid: it is how a control stages a reset back to
    // the composition layer, exactly like the inherited choice on a select.
    if (text === '') continue
    if (isNumericField(key)) {
      if (wholeNumberOf(text, key) === undefined) invalid.add(key)
      continue
    }
    if (text !== 'true' && text !== 'false') invalid.add(key)
  }
  return invalid
}

/**
 * Whether the draft differs from the resolved policy.
 * @param draft - the staged text.
 * @param baseline - the resolved policy.
 * @returns whether a save would write anything.
 */
export function isDirty(draft: RetentionDraft, baseline: RetentionSettings): boolean {
  const current = draftFrom(baseline)
  return FIELD_KEYS.some(key => draft[key].trim() !== current[key])
}

/**
 * Turn the staged draft into the one atomic write the page submits.
 *
 * Only changed fields are submitted: an untouched field keeps the user-layer entry
 * it already has instead of being rewritten on every save. A field staged empty is
 * submitted as an unset, which restores inheritance.
 * @param draft - the staged text.
 * @param baseline - the resolved policy the snapshot showed.
 * @returns the ordered operations; empty when nothing changed.
 */
export function pendingOps(draft: RetentionDraft, baseline: RetentionSettings): readonly RetentionPathOp[] {
  const current = draftFrom(baseline)
  const ops: RetentionPathOp[] = []
  for (const key of FIELD_KEYS) {
    const text = draft[key].trim()
    if (text === current[key]) continue
    if (text === '') {
      ops.push({ op: 'unset', path: [key] })
      continue
    }
    if (isNumericField(key)) {
      const parsed = wholeNumberOf(text, key)
      // The page renders invalid fields and refuses to save, so this branch is
      // reached only if a caller skipped `invalidFields`.
      if (parsed === undefined) continue
      ops.push({ op: 'set', path: [key], value: parsed })
      continue
    }
    ops.push({ op: 'set', path: [key], value: text === 'true' })
  }
  return ops
}

/**
 * Render a byte count with a binary-free, technical unit suffix.
 * @param bytes - the count to render.
 * @returns the rendered size, such as `394 MB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rendered = value >= 10 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${String(rendered)} ${units[unit] ?? 'B'}`
}
