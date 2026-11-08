/**
 * The guarded two-stage retention sweep.
 *
 * No Session delete exists anywhere in the harness — the persistence service
 * exposes `create/open/flush/stat/list`, the controller has no delete RPC, and
 * `archive` touches no file — so this plugin owns the filesystem work. Deletion
 * is therefore TWO stages, and only the second is irreversible:
 *
 * 1. MOVE. A candidate's whole Session directory is `rename(2)`d into
 *    `$DSH_HOME/cache/session-trash/<projectKey>/<sessionId>/`. The rename is
 *    atomic on one filesystem, so the Session disappears from every list at once
 *    while staying restorable for the grace window. That directory lives under
 *    the config home's already-ignored `cache/`, so 394 MB of raw transcript can
 *    never be committed to the public home repository.
 * 2. PURGE. Directories older than `trashGraceDays` are removed. This is the
 *    only unlink path in the plugin.
 *
 * Age is the newest of the header's `createdAt` and the artifact file's `mtime`
 * — the two durable signals that exist. `lastPromptAt` is deliberately not used:
 * it advances only on a human prompt, so a resumed Session worked on by the
 * agent alone would look idle. `stat` is read from `location.path`, the
 * materialized per-Session artifact the seam documents; `revision` is an opaque
 * token by contract and is never parsed for a timestamp.
 *
 * Safety, in the order it is applied: a pinned Session is never a candidate, a
 * Session this process has an Agent or Session object for is never a candidate,
 * a `workspace/session-activity` answer of "active" is never a candidate, a
 * subagent child is a candidate only when its parent is one too, and every move
 * re-checks the file, re-confines the directory under the sessions root, and
 * claims single-writer ownership through `open(id, 'write')` before the rename.
 * The handle is closed in `finally` on every branch — a leaked write handle
 * wedges the id in-process behind a lock and leaks a kernel descriptor.
 *
 * @module dsh-session-retention/sweep
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'

/** Milliseconds in one day, the unit every age in this module is expressed in. */
const DAY_MS = 86_400_000

/** How long a preview stays usable; a delete after this is refused, never silently re-scoped. */
const PREVIEW_TTL_MS = 10 * 60_000

/** Why a Session that looked like a candidate was left alone. */
export const SKIP_REASONS = ['live', 'active', 'pinned', 'owned', 'agentChild', 'legacyError', 'exdev', 'error'] as const

/** One reason a candidate was skipped. */
export type SkipReason = typeof SKIP_REASONS[number]

/** Per-reason counters for one run. */
export type SkipCounts = Record<SkipReason, number>

/** The policy the engine runs under; a snapshot of the live volatile config. */
export interface RetentionPolicy {
  /** Age threshold in days. */
  readonly retentionDays: number
  /** Whether an AUTOMATIC run only previews. It never gates an explicit delete. */
  readonly dryRun: boolean
  /** Hours a moved Session stays restorable (0 purges on the next tick). */
  readonly trashGraceDays: number
  /** Upper bound on moves in one run. */
  readonly maxMovesPerRun: number
}

/** What one sweep, preview, or purge did. */
export interface SweepReport {
  /** ISO start of the run. */
  readonly startedAt: string
  /** ISO end of the run. */
  readonly finishedAt: string
  /** `preview` moved nothing (a dry run or a bare candidate scan); `sweep` moved Sessions. */
  readonly mode: 'preview' | 'sweep'
  /** Candidates in scope before the per-run bound. */
  readonly reviewed: number
  /** Directories moved into the trash by this run. */
  readonly moved: number
  /** Directories the trash purge reclaimed by this run. */
  readonly purged: number
  /** Bytes that left the sessions root. Not freed disk: the trash still holds them. */
  readonly movedBytes: number
  /** Bytes the purge actually reclaimed. */
  readonly purgedBytes: number
  /** Reviewed candidates this run could not move, so a later run can. */
  readonly remaining: number
  /** Why eligible-looking candidates were skipped. */
  readonly skipped: SkipCounts
  /** Non-fatal failures, one line each, safe to show an operator. */
  readonly errors: readonly string[]
}

/** One frozen candidate scan, bound to the exact id set it showed. */
export interface PreviewReport {
  /** Single-use token the delete must present. */
  readonly previewId: string
  /** Candidate ids, oldest first. */
  readonly ids: readonly string[]
  /** Digest of `(retentionDays, sorted ids)`; the delete recomputes it and refuses a mismatch. */
  readonly fingerprint: string
  /** How many Sessions the preview covered. */
  readonly reviewed: number
  /** Total bytes those Sessions occupy today. */
  readonly bytes: number
  /** The window the preview was computed under. */
  readonly retentionDays: number
  /** ISO instant after which the token is refused. */
  readonly expiresAt: string
}

/** Reclaimed-trash result. */
export interface PurgeReport {
  /** Directories removed. */
  readonly purged: number
  /** Bytes those directories held. */
  readonly purgedBytes: number
  /** Set when the purge refused to touch the trash root at all. */
  readonly refused?: string
}

/** What the trash holds right now. */
export interface TrashStats {
  /** Restorable Session directories. */
  readonly sessions: number
  /** Bytes they hold. */
  readonly bytes: number
}

/** Everything the engine reaches outside itself. */
export interface SweepDeps {
  /** Stored-Session observation. */
  readonly listSnapshots: () => Promise<readonly SessionPersistenceSnapshot[]>
  /** Claim single-writer ownership; rejects `SessionAlreadyOwnedError` when taken. */
  readonly openWrite: (sessionId: SessionId) => Promise<{ close: () => Promise<void> }>
  /** Registry-global pin set: an explicit keep-intent signal. */
  readonly pinnedIds: () => readonly SessionId[]
  /** Whether this process has an Agent or Session object for the id. */
  readonly isLive: (sessionId: SessionId) => boolean
  /** Whether `workspace/session-activity` reports running work for the id. */
  readonly hasActivity: (sessionId: SessionId) => Promise<boolean>
  /** Drop an id from the registry's archive set; tolerates an unknown id. */
  readonly unarchive: (sessionId: SessionId) => Promise<void>
  /** Debug sink. */
  readonly log: (message: string) => void
  /** `<home>/sessions`. */
  readonly sessionsRoot: string
  /** `<home>/cache/session-trash`. */
  readonly trashRoot: string
  /** Clock, injectable for a deterministic bound in verification. */
  readonly now?: () => number
}

/** A preview token was presented after its TTL, or already used. */
export class PreviewExpiredError extends Error {
  /** Distinguishable without `instanceof`, which a duplicated install can defeat. */
  readonly code = 'PREVIEW_EXPIRED'

  /** @param message - operator-facing refusal. */
  constructor(message = 'the preview expired or was already used') {
    super(message)
    this.name = 'PreviewExpiredError'
  }
}

/** The candidate set changed between the preview and the delete. */
export class PreviewStaleError extends Error {
  /** Distinguishable without `instanceof`. */
  readonly code = 'PREVIEW_STALE'

  /** @param message - operator-facing refusal. */
  constructor(message = 'the candidate set changed since the preview; preview again') {
    super(message)
    this.name = 'PreviewStaleError'
  }
}

/** Another sweep, preview, or purge already owns the engine. */
export class SweepBusyError extends Error {
  /** Distinguishable without `instanceof`. */
  readonly code = 'SWEEP_BUSY'

  /** @param message - operator-facing refusal. */
  constructor(message = 'another retention run is already in progress') {
    super(message)
    this.name = 'SweepBusyError'
  }
}

/** Options for one sweep. */
export interface SweepOptions {
  /** `preview` reports candidates only; `sweep` moves them. */
  readonly mode: 'preview' | 'sweep'
  /** The review this delete is bound to; absent means an unbounded operator sweep. */
  readonly previewId?: string
}

/** One aged Session, with everything the move needs re-checked later. */
interface Candidate {
  readonly id: SessionId
  readonly dir: string
  readonly artifactPath: string
  readonly projectKey: string
  readonly createdAt: number
  readonly ageBasis: number
  readonly bytes: number
  readonly legacy: boolean
  readonly origin?: 'subagent'
  readonly parentSession?: SessionId
}

/** One scan: what is eligible now, and why the rest was not. */
interface ScanResult {
  readonly candidates: readonly Candidate[]
  readonly skipped: SkipCounts
  readonly errors: readonly string[]
}

/** A frozen preview awaiting its delete. */
interface StoredPreview {
  readonly ids: readonly SessionId[]
  readonly fingerprint: string
  readonly expiresAt: number
}

/** One move attempt's outcome. */
type MoveOutcome =
  | { readonly kind: 'moved'; readonly bytes: number; readonly warning?: string }
  | { readonly kind: 'skip'; readonly reason: SkipReason }
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly message: string }

/** An empty counter set. */
function emptySkip(): SkipCounts {
  return { live: 0, active: 0, pinned: 0, owned: 0, agentChild: 0, legacyError: 0, exdev: 0, error: 0 }
}

/** Whether a rejection carries one errno code. */
function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

/** One line of an error, for a report field an operator reads. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a rejection is the persistence seam's "someone else writes this Session" signal. */
function isAlreadyOwned(error: unknown): boolean {
  // The seam sets `name` explicitly, so this survives a duplicated install where
  // `instanceof` against the Host's class object would not.
  return error instanceof Error && error.name === 'SessionAlreadyOwnedError'
}

/** Whether another local OS user could replace a child of this directory. */
function isTrustedDirectory(stats: Stats): boolean {
  if (!stats.isDirectory()) return false
  // POSIX ownership and mode bits have no Windows equivalent.
  if (process.platform === 'win32' || process.geteuid === undefined) return true
  return stats.uid === process.geteuid() && (stats.mode & 0o022) === 0
}

/**
 * Check that no ancestor lets another local OS user replace the selected child.
 * A sticky writable ancestor is safe, because only the child's owner can then
 * rename over it; this admits the ordinary per-user directories under `/tmp`.
 * @param path - the directory whose ancestry must be protected.
 * @returns whether every ancestor is safe.
 */
async function hasProtectedAncestors(path: string): Promise<boolean> {
  if (process.platform === 'win32' || process.geteuid === undefined) return true
  const currentUid = process.geteuid()
  let child = path
  let childStats = await lstat(child)
  for (;;) {
    const parent = dirname(child)
    if (parent === child) return true
    const stats = await lstat(parent)
    if (!stats.isDirectory()) return false
    const writableByOthers = (stats.mode & 0o022) !== 0
    const sticky = (stats.mode & 0o1000) !== 0
    if (writableByOthers && !sticky) return false
    if (writableByOthers && childStats.uid !== currentUid) return false
    child = parent
    childStats = stats
  }
}

/**
 * Total size of the plain files directly inside one directory.
 * @param dir - the directory to measure.
 * @param fallback - value used when the directory cannot be read.
 * @returns the summed file sizes.
 */
async function directoryBytes(dir: string, fallback: number): Promise<number> {
  let total = 0
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      try {
        total += (await stat(join(dir, entry.name))).size
      } catch {
        // A file that vanished mid-measure contributes nothing; the byte count is
        // reporting, never a safety input.
      }
    }
  } catch {
    return fallback
  }
  return total
}

/**
 * Digest the exact review a delete is bound to.
 * @param retentionDays - the window in force when the preview ran.
 * @param ids - the candidate ids, in any order.
 * @returns the fingerprint the delete recomputes.
 */
function fingerprintOf(retentionDays: number, ids: readonly SessionId[]): string {
  const sorted = ids.map(String).sort()
  return createHash('sha256').update(`${String(retentionDays)}|${sorted.join(',')}`).digest('hex')
}

/** Older first, then by id, so a bounded batch is deterministic across runs and hosts. */
function oldestFirst(left: Candidate, right: Candidate): number {
  if (left.ageBasis !== right.ageBasis) return left.ageBasis - right.ageBasis
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/** The sweep engine: one instance per Host fiber. */
export class RetentionSweep {
  private readonly previews = new Map<string, StoredPreview>()
  private readonly deps: SweepDeps
  private report: SweepReport | undefined
  private busy = false

  /** @param deps - the seams the engine reaches outside itself. */
  constructor(deps: SweepDeps) {
    this.deps = deps
  }

  /** The last completed run, which the page renders. */
  lastReport(): SweepReport | undefined {
    return this.report
  }

  /** Whether a run currently owns the engine. */
  get running(): boolean {
    return this.busy
  }

  /**
   * Freeze the current candidate scan behind a single-use token.
   * @param policy - the policy to review under.
   * @returns the frozen review.
   */
  preview(policy: RetentionPolicy): Promise<PreviewReport> {
    return this.exclusive(async () => {
      const startedAt = this.now()
      const scan = await this.scan(policy)
      const ids = scan.candidates.map(candidate => candidate.id)
      const fingerprint = fingerprintOf(policy.retentionDays, ids)
      const previewId = randomUUID()
      const expiresAt = startedAt + PREVIEW_TTL_MS
      this.prunePreviews()
      this.previews.set(previewId, { ids, fingerprint, expiresAt })
      const bytes = scan.candidates.reduce((total, candidate) => total + candidate.bytes, 0)
      this.report = {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(this.now()).toISOString(),
        mode: 'preview',
        reviewed: ids.length,
        moved: 0,
        purged: 0,
        movedBytes: 0,
        purgedBytes: 0,
        remaining: ids.length,
        skipped: scan.skipped,
        errors: scan.errors,
      }
      return {
        previewId,
        ids: ids.map(String),
        fingerprint,
        reviewed: ids.length,
        bytes,
        retentionDays: policy.retentionDays,
        expiresAt: new Date(expiresAt).toISOString(),
      }
    })
  }

  /**
   * Purge expired trash, then move the oldest-first batch of candidates.
   * @param policy - the policy in force.
   * @param options - `preview` reports only; `sweep` moves, bound to `previewId` when given.
   * @returns what the run did.
   */
  sweep(policy: RetentionPolicy, options: SweepOptions): Promise<SweepReport> {
    return this.exclusive(async () => {
      const startedAt = this.now()
      // The purge is not gated by `dryRun`: the move into trash was already the
      // operator's approved destructive step, and the grace window is its own gate.
      const purge = await this.purgeTrashUnlocked(policy)
      const scan = await this.scan(policy)
      const errors: string[] = [...scan.errors]
      if (purge.refused !== undefined) errors.push(`trash purge refused: ${purge.refused}`)
      const skipped: SkipCounts = { ...scan.skipped }
      let reviewed = scan.candidates.length
      let batch: readonly Candidate[] = scan.candidates
      if (options.previewId !== undefined) {
        const review = this.consumePreview(options.previewId, policy, scan.candidates)
        reviewed = review.ids.length
        const reviewedIds = new Set(review.ids.map(String))
        batch = scan.candidates.filter(candidate => reviewedIds.has(String(candidate.id)))
      }
      let moved = 0
      let movedBytes = 0
      if (options.mode === 'sweep') {
        for (const candidate of batch.slice(0, this.bound(policy.maxMovesPerRun))) {
          const outcome = await this.moveOne(candidate, policy)
          switch (outcome.kind) {
            case 'moved':
              moved += 1
              movedBytes += outcome.bytes
              if (outcome.warning !== undefined) errors.push(`${String(candidate.id)}: ${outcome.warning}`)
              break
            case 'skip':
              skipped[outcome.reason] += 1
              break
            case 'failed':
              skipped.error += 1
              errors.push(`${String(candidate.id)}: ${outcome.message}`)
              break
            case 'gone':
              // The directory left on its own between the scan and the move; it is
              // neither moved nor skipped for a reason worth counting.
              break
          }
        }
      }
      const finishedAt = this.now()
      this.report = {
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        mode: options.mode,
        reviewed,
        moved,
        purged: purge.purged,
        movedBytes,
        purgedBytes: purge.purgedBytes,
        remaining: Math.max(0, reviewed - moved),
        skipped,
        errors,
      }
      this.deps.log(
        `dsh-session-retention: ${options.mode} reviewed=${String(reviewed)} moved=${String(moved)} `
        + `purged=${String(purge.purged)} remaining=${String(this.report.remaining)}`,
      )
      return this.report
    })
  }

  /**
   * Reclaim every trash directory past the grace window.
   * @param policy - the policy in force.
   * @returns what the purge reclaimed.
   */
  purgeTrash(policy: RetentionPolicy): Promise<PurgeReport> {
    return this.exclusive(async () => await this.purgeTrashUnlocked(policy))
  }

  /**
   * Measure what the trash currently holds.
   * @returns restorable directories and their bytes.
   */
  async trashStats(): Promise<TrashStats> {
    let sessions = 0
    let bytes = 0
    let root: string
    try {
      root = await realpath(this.deps.trashRoot)
    } catch {
      return { sessions: 0, bytes: 0 }
    }
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch {
      return { sessions: 0, bytes: 0 }
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = join(root, project.name)
      let entries
      try {
        entries = await readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = join(projectDir, entry.name)
        sessions += 1
        bytes += await directoryBytes(dir, 0)
      }
    }
    return { sessions, bytes }
  }

  /** Run one exclusive operation, refusing a concurrent one instead of queueing it. */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new SweepBusyError()
    this.busy = true
    try {
      return await operation()
    } finally {
      this.busy = false
    }
  }

  /** The clock. */
  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** A positive integer bound, so a fractional or nonsensical config cannot wedge a run. */
  private bound(value: number): number {
    const normalized = Math.trunc(value)
    return Number.isFinite(normalized) && normalized > 0 ? normalized : 1
  }

  /** Drop tokens past their TTL so an abandoned preview cannot be replayed later. */
  private prunePreviews(): void {
    const now = this.now()
    for (const [id, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(id)
    }
  }

  /** Consume one token, refusing a missing, expired, or stale review. */
  private consumePreview(
    previewId: string,
    policy: RetentionPolicy,
    candidates: readonly Candidate[],
  ): StoredPreview {
    const stored = this.previews.get(previewId)
    // Single use: consumed even on a refusal, so a second attempt cannot ride the
    // same review after the candidate set moved underneath it.
    this.previews.delete(previewId)
    if (stored === undefined || stored.expiresAt <= this.now()) throw new PreviewExpiredError()
    const fingerprint = fingerprintOf(policy.retentionDays, candidates.map(candidate => candidate.id))
    if (fingerprint !== stored.fingerprint) throw new PreviewStaleError()
    return stored
  }

  /** Enumerate what is eligible under one policy, in oldest-first order. */
  private async scan(policy: RetentionPolicy): Promise<ScanResult> {
    const skipped = emptySkip()
    const errors: string[] = []
    const now = this.now()
    const threshold = this.bound(policy.retentionDays) * DAY_MS
    const pinned = new Set(this.deps.pinnedIds().map(String))
    let snapshots
    try {
      snapshots = await this.deps.listSnapshots()
    } catch (error) {
      throw new Error(`the stored Session list could not be read: ${messageOf(error)}`)
    }
    const aged: Candidate[] = []
    for (const snapshot of snapshots) {
      const location = snapshot.location
      // A snapshot without a materialized artifact has no directory to move and,
      // for a pending Session, may never have existed on disk.
      if (location === undefined) continue
      const id = snapshot.header.id
      let artifact: Stats
      try {
        artifact = await stat(location.path)
      } catch (error) {
        if (isErrno(error, 'ENOENT')) continue
        skipped.error += 1
        errors.push(`${String(id)}: ${messageOf(error)}`)
        continue
      }
      const ageBasis = Math.max(snapshot.header.createdAt, artifact.mtimeMs)
      if (now - ageBasis < threshold) continue
      if (this.deps.isLive(id)) {
        skipped.live += 1
        continue
      }
      if (pinned.has(String(id))) {
        skipped.pinned += 1
        continue
      }
      const dir = dirname(location.path)
      aged.push({
        id,
        dir,
        artifactPath: location.path,
        projectKey: basename(dirname(dir)),
        createdAt: snapshot.header.createdAt,
        ageBasis,
        bytes: await directoryBytes(dir, snapshot.sizeBytes ?? 0),
        legacy: snapshot.formatStatus === 'migration-required',
        ...(snapshot.header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
        ...(snapshot.header.parentSession === undefined ? {} : { parentSession: snapshot.header.parentSession }),
      })
    }
    // One id-set pass, so a lineage moves together or not at all: a retained
    // parent must never keep transcript references to a moved child.
    const agedIds = new Set(aged.map(candidate => String(candidate.id)))
    const candidates: Candidate[] = []
    for (const candidate of aged) {
      if (candidate.origin === 'subagent') {
        const parent = candidate.parentSession
        if (parent === undefined || !agedIds.has(String(parent))) {
          skipped.agentChild += 1
          continue
        }
      }
      if (await this.deps.hasActivity(candidate.id)) {
        skipped.active += 1
        continue
      }
      candidates.push(candidate)
    }
    candidates.sort(oldestFirst)
    return { candidates, skipped, errors }
  }

  /** Move one candidate into the trash under the full guard set. */
  private async moveOne(candidate: Candidate, policy: RetentionPolicy): Promise<MoveOutcome> {
    const threshold = this.bound(policy.retentionDays) * DAY_MS
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(this.deps.sessionsRoot)
    } catch (error) {
      return { kind: 'failed', message: `the sessions root could not be resolved: ${messageOf(error)}` }
    }
    // Realpath confinement: the directory must be exactly
    // `<sessionsRoot>/<projectKey>/<sessionId>`, never a symlink out of the root.
    const expected = join(canonicalRoot, candidate.projectKey, String(candidate.id))
    let actual: string
    try {
      actual = await realpath(candidate.dir)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'gone' }
      return { kind: 'failed', message: `the Session directory could not be resolved: ${messageOf(error)}` }
    }
    if (actual !== expected) {
      return { kind: 'failed', message: `refused a directory outside the sessions root: ${actual}` }
    }
    // Re-stat immediately before the move: a Session resumed since the scan is no
    // longer a candidate, whatever the earlier snapshot said.
    let artifact: Stats
    try {
      artifact = await stat(candidate.artifactPath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'gone' }
      return { kind: 'failed', message: `the artifact could not be re-read: ${messageOf(error)}` }
    }
    if (this.now() - Math.max(candidate.createdAt, artifact.mtimeMs) < threshold) {
      return { kind: 'skip', reason: 'active' }
    }
    let handle: { close: () => Promise<void> }
    try {
      handle = await this.deps.openWrite(candidate.id)
    } catch (error) {
      if (isAlreadyOwned(error)) return { kind: 'skip', reason: 'owned' }
      // A legacy generation is migrated BY this write open, so a failure here is
      // the migration itself; it is reported apart from an ordinary error.
      if (candidate.legacy) return { kind: 'skip', reason: 'legacyError' }
      return { kind: 'failed', message: `the write-ownership probe failed: ${messageOf(error)}` }
    }
    try {
      const trashDir = await this.ensureTrashDir(candidate.projectKey)
      if (trashDir === undefined) {
        return { kind: 'failed', message: `the trash root ${this.deps.trashRoot} is not a directory this user owns` }
      }
      try {
        await rename(candidate.dir, join(trashDir, String(candidate.id)))
      } catch (error) {
        if (isErrno(error, 'EXDEV')) return { kind: 'skip', reason: 'exdev' }
        if (isErrno(error, 'ENOENT')) return { kind: 'gone' }
        return { kind: 'failed', message: `the move failed: ${messageOf(error)}` }
      }
      let warning: string | undefined
      try {
        // The archive set is the one piece of re-carried state with a public
        // repair; every other store tolerates a stale id and has no detach API.
        await this.deps.unarchive(candidate.id)
      } catch (error) {
        warning = `moved, but the archive set was not repaired: ${messageOf(error)}`
      }
      return warning === undefined ? { kind: 'moved', bytes: candidate.bytes } : { kind: 'moved', bytes: candidate.bytes, warning }
    } finally {
      // Every branch, including a refusal: a leaked write handle wedges the id
      // in-process behind a lock and leaks a kernel descriptor.
      try {
        await handle.close()
      } catch (error) {
        this.deps.log(`dsh-session-retention: closing the probe handle failed: ${messageOf(error)}`)
      }
    }
  }

  /** Create (and trust-check) the per-project trash directory. */
  private async ensureTrashDir(projectKey: string): Promise<string | undefined> {
    if (!await this.ensureTrashRoot()) return undefined
    const dir = join(this.deps.trashRoot, projectKey)
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.deps.log(`dsh-session-retention: could not create ${dir}: ${messageOf(error)}`)
      return undefined
    }
    return dir
  }

  /**
   * Ensure the trash root exists and no other local user can replace its children.
   * The move and the purge both refuse to run against a root that fails this, so a
   * misconfigured `$DSH_HOME` cannot turn a cleanup into another user's write.
   */
  private async ensureTrashRoot(): Promise<boolean> {
    try {
      await mkdir(this.deps.trashRoot, { recursive: true, mode: 0o700 })
    } catch (error) {
      this.deps.log(`dsh-session-retention: could not create the trash root: ${messageOf(error)}`)
      return false
    }
    try {
      const stats = await lstat(this.deps.trashRoot)
      if (stats.isSymbolicLink() || !isTrustedDirectory(stats)) return false
      return await hasProtectedAncestors(this.deps.trashRoot)
    } catch (error) {
      this.deps.log(`dsh-session-retention: could not inspect the trash root: ${messageOf(error)}`)
      return false
    }
  }

  /** The purge body, called with the engine already owned by this run. */
  private async purgeTrashUnlocked(policy: RetentionPolicy): Promise<PurgeReport> {
    if (!await this.ensureTrashRoot()) {
      return { purged: 0, purgedBytes: 0, refused: `${this.deps.trashRoot} is not a directory this user owns` }
    }
    const graceMs = Math.max(0, Math.trunc(policy.trashGraceDays)) * DAY_MS
    let root: string
    try {
      root = await realpath(this.deps.trashRoot)
    } catch (error) {
      return { purged: 0, purgedBytes: 0, refused: messageOf(error) }
    }
    let projects
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch {
      return { purged: 0, purgedBytes: 0 }
    }
    const now = this.now()
    let purged = 0
    let purgedBytes = 0
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const projectDir = join(root, project.name)
      let entries
      try {
        entries = await readdir(projectDir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = join(projectDir, entry.name)
        let info: Stats
        try {
          info = await stat(dir)
        } catch {
          continue
        }
        // `trashGraceDays: 0` means "the next tick", not "never".
        if (graceMs > 0 && now - info.mtimeMs < graceMs) continue
        let canonical: string
        try {
          canonical = await realpath(dir)
        } catch {
          continue
        }
        // Confinement again: only a direct grandchild of the trash root is removed.
        if (dirname(dirname(canonical)) !== root) continue
        const bytes = await directoryBytes(canonical, 0)
        try {
          await rm(canonical, { recursive: true, force: true })
        } catch (error) {
          this.deps.log(`dsh-session-retention: could not purge ${canonical}: ${messageOf(error)}`)
          continue
        }
        purged += 1
        purgedBytes += bytes
      }
      // Keep the trash's own scaffolding from accumulating: an empty project
      // directory carries no restorable Session, and `$DSH_HOME` is a git tree.
      try {
        await rmdir(projectDir)
      } catch {
        // Still holds a restorable Session (ENOTEMPTY) or already gone.
      }
    }
    return { purged, purgedBytes }
  }
}
