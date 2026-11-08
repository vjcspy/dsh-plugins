/**
 * The Session-retention page: the six policy fields, the last run, and the three
 * cleanup controls.
 *
 * The page is reached from its own row on the Plugins page (the bundle patch
 * declares that row, and the browser half registers `plugins.row.config` under
 * `<package>#<rowId>`). The panel supplies the Host form — `form.state` plus
 * `form.mutate` — so the page owns no second write path: it stages a local draft,
 * saves it in one atomic mutation fenced by the revision it read, and treats a
 * refusal as a refresh of Host state rather than a retry loop.
 *
 * The controls are bound to the review they showed, never to a recomputed set:
 * `Preview cleanup` freezes a candidate scan into a single-use `previewId`,
 * `Delete now` presents that id, and the Host refuses with `PREVIEW_STALE` when
 * the candidate set moved in between. That is why the delete needs two clicks —
 * the first arms the control and states what it will do.
 *
 * Nothing here renders a product string: every label comes from the page's locale
 * namespace.
 *
 * @module dsh-session-retention/client/SessionRetentionPage
 */

import { useEffect, useId, useMemo, useState } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  FIELD_KEYS, draftFrom, formatBytes, invalidFields, isDirty, overriddenFields, pendingOps, settingsFrom,
} from './retention-page-controller.ts'
import type { FieldKey, RetentionDraft, RetentionSettings } from './retention-page-controller.ts'

/** Locale namespace this page's copy is registered under. */
export const PAGE_LOCALE_NAMESPACE = 'dshSessionRetention'

/*
 * The three fenced paths are spelled here rather than imported from the Host half:
 * a client half must not depend on a Host module, and the browser bundle has no
 * Node face. They are the plugin's own route names, so they only have to agree
 * with `src/routes.ts`.
 */
/** The report read; `?preview=1` also freezes a review. */
const REPORT_PATH = '/api/dsh-session-retention/report'
/** The bound delete. */
const SWEEP_PATH = '/api/dsh-session-retention/sweep'
/** The explicit trash purge. */
const PURGE_TRASH_PATH = '/api/dsh-session-retention/purge-trash'

/** Style element id, so a hot reload replaces instead of stacking. */
const STYLE_ID = 'dsh-session-retention-page'

/** The page's stylesheet: layout and control chrome only, all values tokenised with a fallback. */
const PAGE_CSS = `
.dsh-session-retention-page { display: flex; flex-direction: column; gap: 18px; }
.dsh-session-retention-group { display: flex; flex-direction: column; gap: 10px; }
.dsh-session-retention-heading { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; opacity: .62; }
.dsh-session-retention-fields { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.dsh-session-retention-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-session-retention-fieldhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-session-retention-label { font-size: 12px; font-weight: 500; }
.dsh-session-retention-reset { padding: 0; border: 0; background: none; color: inherit; font: inherit; font-size: 11px; opacity: .7; cursor: pointer; text-decoration: underline; }
.dsh-session-retention-reset:disabled { opacity: .35; cursor: default; }
.dsh-session-retention-input { box-sizing: border-box; width: 100%; padding: 6px 8px; border: 1px solid var(--dsw-color-border, #3c3c3c); border-radius: 6px; background: var(--dsw-color-surface-raised, transparent); color: inherit; font: inherit; }
.dsh-session-retention-input:disabled { opacity: .55; }
.dsh-session-retention-hint { font-size: 11px; opacity: .68; }
.dsh-session-retention-invalid { font-size: 11px; color: var(--dsw-color-danger, #e5534b); }
.dsh-session-retention-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dsh-session-retention-button { padding: 5px 11px; border: 1px solid var(--dsw-color-border, #3c3c3c); border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-session-retention-button:disabled { opacity: .5; cursor: default; }
.dsh-session-retention-button[data-tone="primary"] { border-color: var(--dsw-color-accent, #4c8dff); color: var(--dsw-color-accent, #4c8dff); }
.dsh-session-retention-button[data-tone="danger"] { border-color: var(--dsw-color-danger, #e5534b); color: var(--dsw-color-danger, #e5534b); }
.dsh-session-retention-stats { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
.dsh-session-retention-stat { display: flex; flex-direction: column; gap: 2px; }
.dsh-session-retention-statlabel { font-size: 11px; opacity: .62; }
.dsh-session-retention-statvalue { font-size: 15px; font-weight: 600; }
.dsh-session-retention-message { margin: 0; font-size: 12px; }
.dsh-session-retention-message[data-tone="error"] { color: var(--dsw-color-danger, #e5534b); }
`

/**
 * Install the page stylesheet once.
 * @returns the disposer removing it.
 */
export function installPageStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  existing?.remove()
  const element = document.createElement('style')
  element.id = STYLE_ID
  element.textContent = PAGE_CSS
  document.head.append(element)
  return () => { element.remove() }
}

/** One answer from a fenced route. */
interface Envelope {
  readonly success?: unknown
  readonly data?: unknown
  readonly error?: { readonly code?: unknown; readonly message?: unknown }
}

/** A route refusal that carries the Host's own error code. */
class RouteRefusal extends Error {
  /** The Host's error code, such as `PREVIEW_STALE`. */
  readonly code: string

  /**
   * @param code - the Host's error code.
   * @param message - the Host's message, already operator-facing.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'RouteRefusal'
    this.code = code
  }
}

/**
 * Call one fenced route and unwrap its `{ success, data | error }` envelope.
 *
 * The channel admits the call on the browser cookie, so every request goes out
 * `same-origin` with the credentials the page already holds.
 * @param path - the fenced pathname, query included.
 * @param init - fetch options.
 * @returns the `data` payload.
 */
async function callRoute(path: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch (error) {
    throw new RouteRefusal('UNREACHABLE', error instanceof Error ? error.message : String(error))
  }
  let body: Envelope | undefined
  try {
    body = await response.json() as Envelope
  } catch {
    body = undefined
  }
  if (!response.ok || body?.success !== true) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : `HTTP_${String(response.status)}`
    const message = typeof body?.error?.message === 'string' ? body.error.message : `the Host answered ${String(response.status)}`
    throw new RouteRefusal(code, message)
  }
  return body.data
}

/** One Session count and byte pair, narrowed from an unknown payload. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** A narrowed report record. */
interface ReportSummary {
  readonly mode: string
  readonly reviewed: number
  readonly moved: number
  readonly remaining: number
  readonly movedBytes: number
  readonly purged: number
  readonly purgedBytes: number
}

/** A narrowed frozen review. */
interface PreviewSummary {
  readonly previewId: string
  readonly reviewed: number
  readonly bytes: number
}

/** Everything the page reads from the Host besides the settings form. */
interface PanelState {
  /** Restorable Sessions and their bytes. */
  readonly trash?: { readonly sessions: number; readonly bytes: number }
  /** The last completed run. */
  readonly report?: ReportSummary
  /** The review a delete is bound to. */
  readonly preview?: PreviewSummary
}

/** Narrow a `lastReport` payload. */
function reportOf(value: unknown): ReportSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.mode !== 'string') return undefined
  return {
    mode: record.mode,
    reviewed: countOf(record.reviewed),
    moved: countOf(record.moved),
    remaining: countOf(record.remaining),
    movedBytes: countOf(record.movedBytes),
    purged: countOf(record.purged),
    purgedBytes: countOf(record.purgedBytes),
  }
}

/** Narrow a `preview` payload; a malformed one is reported as no review rather than rendered half-built. */
function previewOf(value: unknown): PreviewSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.previewId !== 'string' || record.previewId === '') return undefined
  return { previewId: record.previewId, reviewed: countOf(record.reviewed), bytes: countOf(record.bytes) }
}

/** Two-choice labels for a boolean field. */
interface BooleanChoices {
  readonly enabled: string
  readonly disabled: string
}

/** What one rendered field needs. */
interface RetentionFieldProps {
  /** Visible label. */
  readonly label: string
  /** One-line explanation. */
  readonly hint: string
  /** Draft text this control renders. */
  readonly value: string
  /** Boolean fields render a two-choice select instead of a text input. */
  readonly choices?: BooleanChoices
  /** Whether every control is read-only. */
  readonly disabled: boolean
  /** Whether a user-layer entry already overrides this field. */
  readonly overridden: boolean
  /** Whether the draft fails local validation. */
  readonly invalid: boolean
  /** Copy for the inherited option, the reset control, and the validation message. */
  readonly labels: { readonly inherited: string; readonly reset: string; readonly invalid: string }
  /** Stage new draft text. */
  readonly onChange: (value: string) => void
  /** Stage a clear, so the field re-inherits the composition layer. */
  readonly onReset: () => void
}

/**
 * Render one field: a two-choice select for a boolean, a text input for a number.
 * @param props - the field's copy, its staged text, and its edit actions.
 * @returns the labelled control.
 */
function RetentionField(props: RetentionFieldProps) {
  const id = useId()
  return (
    <div className="dsh-session-retention-field">
      <div className="dsh-session-retention-fieldhead">
        <label className="dsh-session-retention-label" htmlFor={id}>{props.label}</label>
        {props.overridden
          ? <button type="button" className="dsh-session-retention-reset" disabled={props.disabled} onClick={props.onReset}>{props.labels.reset}</button>
          : null}
      </div>
      {props.choices === undefined
        ? (
          <input
            id={id}
            className="dsh-session-retention-input"
            type="text"
            inputMode="numeric"
            value={props.value}
            disabled={props.disabled}
            aria-invalid={props.invalid}
            onChange={(event) => { props.onChange(event.target.value) }}
          />
        )
        : (
          <select
            id={id}
            className="dsh-session-retention-input"
            value={props.value}
            disabled={props.disabled}
            aria-invalid={props.invalid}
            onChange={(event) => {
              if (event.target.value === '') props.onReset()
              else props.onChange(event.target.value)
            }}
          >
            <option value="">{props.labels.inherited}</option>
            <option value="true">{props.choices.enabled}</option>
            <option value="false">{props.choices.disabled}</option>
          </select>
        )}
      {props.invalid
        ? <span className="dsh-session-retention-invalid" role="status">{props.labels.invalid}</span>
        : <span className="dsh-session-retention-hint">{props.hint}</span>}
    </div>
  )
}

/** One labelled statistic. */
interface StatProps {
  /** Copy above the value. */
  readonly label: string
  /** The rendered value. */
  readonly value: string
}

/**
 * Render one statistic.
 * @param props - its label and value.
 * @returns the statistic block.
 */
function Stat(props: StatProps) {
  return (
    <div className="dsh-session-retention-stat">
      <span className="dsh-session-retention-statlabel">{props.label}</span>
      <span className="dsh-session-retention-statvalue">{props.value}</span>
    </div>
  )
}

/** Props the renderer binds for this page. */
export type SessionRetentionPageProps =
  PropsRuntime<'plugins.row.config'>
  & PropsLocale<typeof PAGE_LOCALE_NAMESPACE>

/** Localized copy for one field, resolved from the namespace dictionary. */
type Translate = SessionRetentionPageProps['t']

/**
 * Map a field to the copy keys that label it.
 * @param t - the namespace translate.
 * @param key - the field.
 * @returns its label, hint, and validation message.
 */
function fieldCopy(t: Translate, key: FieldKey): { label: string; hint: string; invalid: string } {
  const invalid = key === 'autoSweep' || key === 'dryRun' ? t('invalidDayCount') : t('invalidNumber')
  switch (key) {
    case 'autoSweep': return { label: t('autoSweep'), hint: t('autoSweepHint'), invalid }
    case 'retentionDays': return { label: t('retentionDays'), hint: t('retentionDaysHint'), invalid }
    case 'sweepIntervalHours': return { label: t('sweepIntervalHours'), hint: t('sweepIntervalHoursHint'), invalid }
    case 'dryRun': return { label: t('dryRun'), hint: t('dryRunHint'), invalid }
    case 'trashGraceDays': return { label: t('trashGraceDays'), hint: t('trashGraceDaysHint'), invalid }
    case 'maxMovesPerRun': return { label: t('maxMovesPerRun'), hint: t('maxMovesPerRunHint'), invalid }
  }
}

/** One refusal code mapped to the message an operator should read. */
function refusalMessage(t: Translate, error: unknown): string {
  if (error instanceof RouteRefusal) {
    switch (error.code) {
      case 'PREVIEW_STALE': return t('previewStale')
      case 'PREVIEW_EXPIRED': return t('previewExpired')
      case 'SWEEP_BUSY': return t('busy')
      default: return t('failed', { message: error.message })
    }
  }
  return t('failed', { message: error instanceof Error ? error.message : String(error) })
}

/**
 * Render the retention page, or its one-liner when the panel asks for a summary.
 * @param props - the view asked for, the Host form, and the page's locale copy.
 * @returns the page.
 */
export function SessionRetentionPage(props: SessionRetentionPageProps) {
  const { t, form, view } = props
  const [draft, setDraft] = useState<RetentionDraft | undefined>(undefined)
  const [panel, setPanel] = useState<PanelState>({})
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState<'delete' | 'purge' | undefined>(undefined)

  const snapshot = form?.state
  const baseline: RetentionSettings = useMemo(() => settingsFrom(snapshot?.value), [snapshot?.value])
  const overridden = useMemo(() => overriddenFields(snapshot?.user), [snapshot?.user])
  const current = draft ?? draftFrom(baseline)
  const invalid = useMemo(() => invalidFields(current), [current])
  const dirty = draft !== undefined && isDirty(draft, baseline)
  const writable = snapshot?.writable === true

  useEffect(() => {
    // The summary view is a one-liner and needs none of this.
    if (view !== 'page') return () => {}
    let cancelled = false
    void (async () => {
      try {
        const data = await callRoute(REPORT_PATH, { method: 'GET' })
        if (cancelled) return
        const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
        const trashRecord = (typeof record.trash === 'object' && record.trash !== null ? record.trash : {}) as Record<string, unknown>
        const report = reportOf(record.lastReport)
        setPanel({
          trash: { sessions: countOf(trashRecord.sessions), bytes: countOf(trashRecord.bytes) },
          ...(report === undefined ? {} : { report }),
        })
      } catch (failure) {
        if (!cancelled) setError(refusalMessage(t, failure))
      }
    })()
    return () => { cancelled = true }
  }, [t, view])

  if (view === 'summary') return <>{t('summary')}</>

  if (form === undefined || snapshot === undefined) {
    return <p className="dsh-session-retention-message">{t('unavailable')}</p>
  }

  const edit = (key: FieldKey, text: string): void => { setDraft({ ...current, [key]: text }) }
  const resetField = (key: FieldKey): void => { setDraft({ ...current, [key]: '' }) }

  const save = async (): Promise<void> => {
    const ops = pendingOps(current, baseline)
    if (ops.length === 0) {
      setDraft(undefined)
      setMessage(undefined)
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const accepted = await form.mutate(ops, snapshot.revision)
      if (accepted) {
        setDraft(undefined)
        setMessage(undefined)
      } else {
        // A refusal is the Host's answer on the current document; the displayed
        // values already follow Host state, so the draft is dropped with it.
        setDraft(undefined)
        setError(t('refused'))
      }
    } catch (failure) {
      setError(refusalMessage(t, failure))
    } finally {
      setBusy(false)
    }
  }

  const preview = async (): Promise<void> => {
    setBusy(true)
    setArmed(undefined)
    setError(undefined)
    try {
      const data = await callRoute(`${REPORT_PATH}?preview=1`, { method: 'GET' })
      const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
      const review = previewOf(record.preview)
      if (review === undefined) {
        setError(t('failed', { message: 'the Host answered without a review' }))
        return
      }
      const report = reportOf(record.lastReport)
      setPanel(previous => ({
        ...previous,
        preview: review,
        ...(report === undefined ? {} : { report }),
      }))
      setMessage(review.reviewed === 0
        ? t('previewEmpty')
        : t('previewReady', { count: review.reviewed, bytes: formatBytes(review.bytes) }))
    } catch (failure) {
      setError(refusalMessage(t, failure))
    } finally {
      setBusy(false)
    }
  }

  const deleteNow = async (): Promise<void> => {
    const review = panel.preview
    if (review === undefined) {
      setError(t('previewRequired'))
      return
    }
    if (armed !== 'delete') {
      setArmed('delete')
      setMessage(t('deleteHint', { days: baseline.trashGraceDays }))
      return
    }
    setArmed(undefined)
    setBusy(true)
    setError(undefined)
    try {
      const data = await callRoute(SWEEP_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'delete', previewId: review.previewId }),
      })
      const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
      const report = reportOf(record.report)
      // The review is consumed by this delete, so the panel keeps only what the
      // Host still knows: the trash, and the run this delete just produced.
      setPanel(previous => ({
        ...(previous.trash === undefined ? {} : { trash: previous.trash }),
        ...(report === undefined ? {} : { report }),
      }))
      setMessage(report === undefined
        ? t('working')
        : t('deleteDone', { moved: report.moved, reviewed: report.reviewed, remaining: report.remaining }))
    } catch (failure) {
      if (failure instanceof RouteRefusal && (failure.code === 'PREVIEW_STALE' || failure.code === 'PREVIEW_EXPIRED')) {
        // The review this page holds is dead: drop it so the operator previews again
        // instead of re-submitting a token the Host already refused.
        setPanel(previous => ({
          ...(previous.trash === undefined ? {} : { trash: previous.trash }),
          ...(previous.report === undefined ? {} : { report: previous.report }),
        }))
      }
      setError(refusalMessage(t, failure))
    } finally {
      setBusy(false)
    }
  }

  const emptyTrash = async (): Promise<void> => {
    if (armed !== 'purge') {
      setArmed('purge')
      setMessage(t('emptyTrashHint'))
      return
    }
    setArmed(undefined)
    setBusy(true)
    setError(undefined)
    try {
      const data = await callRoute(PURGE_TRASH_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      })
      const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
      setPanel(previous => ({ ...previous, trash: { sessions: 0, bytes: 0 } }))
      setMessage(t('emptyTrashDone', { purged: countOf(record.purged), bytes: formatBytes(countOf(record.purgedBytes)) }))
    } catch (failure) {
      setError(refusalMessage(t, failure))
    } finally {
      setBusy(false)
    }
  }

  const labels = { inherited: t('inherited'), reset: t('reset'), invalid: t('invalidNumber') }
  const choices = { enabled: t('on'), disabled: t('off') }
  const fieldDisabled = !writable || busy
  const review = panel.preview

  return (
    <div className="dsh-session-retention-page" aria-busy={busy}>
      {snapshot.status === 'loading'
        ? <p className="dsh-session-retention-message">{t('statLoading')}</p>
        : null}
      <section className="dsh-session-retention-group">
        <h3 className="dsh-session-retention-heading">{t('fieldsTitle')}</h3>
        <div className="dsh-session-retention-fields">
          {FIELD_KEYS.map((key) => {
            const copy = fieldCopy(t, key)
            const isBoolean = key === 'autoSweep' || key === 'dryRun'
            return (
              <RetentionField
                key={key}
                label={copy.label}
                hint={copy.hint}
                value={current[key]}
                {...(isBoolean ? { choices } : {})}
                disabled={fieldDisabled}
                overridden={overridden.has(key)}
                invalid={invalid.has(key)}
                labels={{ inherited: labels.inherited, reset: labels.reset, invalid: copy.invalid }}
                onChange={(text) => { edit(key, text) }}
                onReset={() => { resetField(key) }}
              />
            )
          })}
        </div>
        {writable ? null : <p className="dsh-session-retention-message">{t('readOnly')}</p>}
        <div className="dsh-session-retention-actions">
          <button
            type="button"
            className="dsh-session-retention-button"
            data-tone="primary"
            disabled={!writable || busy || invalid.size > 0 || !dirty}
            onClick={() => { void save() }}
          >{t('save')}</button>
          <button
            type="button"
            className="dsh-session-retention-button"
            disabled={!dirty || busy}
            onClick={() => { setDraft(undefined); setMessage(undefined); setError(undefined) }}
          >{t('discard')}</button>
        </div>
      </section>

      <section className="dsh-session-retention-group">
        <h3 className="dsh-session-retention-heading">{t('statsTitle')}</h3>
        <div className="dsh-session-retention-stats">
          <Stat label={t('statMode')} value={panel.report === undefined ? t('statNever') : (panel.report.mode === 'preview' ? t('modePreview') : t('modeSweep'))} />
          <Stat label={t('statReviewed')} value={String(panel.report?.reviewed ?? 0)} />
          <Stat label={t('statMoved')} value={`${String(panel.report?.moved ?? 0)} (${formatBytes(panel.report?.movedBytes ?? 0)})`} />
          <Stat label={t('statRemaining')} value={String(panel.report?.remaining ?? 0)} />
          <Stat label={t('statTrash')} value={`${String(panel.trash?.sessions ?? 0)} (${formatBytes(panel.trash?.bytes ?? 0)})`} />
          <Stat label={t('statPurged')} value={`${String(panel.report?.purged ?? 0)} (${formatBytes(panel.report?.purgedBytes ?? 0)})`} />
        </div>
      </section>

      <section className="dsh-session-retention-group">
        <h3 className="dsh-session-retention-heading">{t('controlsTitle')}</h3>
        <div className="dsh-session-retention-actions">
          <button
            type="button"
            className="dsh-session-retention-button"
            disabled={busy}
            onClick={() => { void preview() }}
          >{review === undefined ? t('preview') : t('previewAgain')}</button>
          <button
            type="button"
            className="dsh-session-retention-button"
            data-tone="danger"
            disabled={busy || review === undefined}
            onClick={() => { void deleteNow() }}
          >{armed === 'delete' ? t('deleteConfirm') : t('deleteNow')}</button>
          <button
            type="button"
            className="dsh-session-retention-button"
            data-tone="danger"
            disabled={busy || (panel.trash?.sessions ?? 0) === 0}
            onClick={() => { void emptyTrash() }}
          >{armed === 'purge' ? t('emptyTrashConfirm') : t('emptyTrash')}</button>
        </div>
        {message === undefined ? null : <p className="dsh-session-retention-message" role="status">{message}</p>}
        {error === undefined ? null : <p className="dsh-session-retention-message" data-tone="error" role="status">{error}</p>}
      </section>
    </div>
  )
}
