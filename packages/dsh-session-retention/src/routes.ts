/**
 * The three fenced routes on the shared `/api` channel.
 *
 * The channel — not this plugin — owns admission: `connection.admit` runs in the
 * `/api` prefix handler before any route lookup, so a foreign `Host` is refused
 * with `403` and a request without the browser cookie with `401`, whether or not
 * the fenced path exists. Registering through `ctx.connection.fetch.register` is
 * therefore what fences these routes; a raw `ctx.webServer` route would receive no
 * admission at all.
 *
 * No extra CSRF layer is added on top: the browser session cookie is host-only,
 * `HttpOnly` and `SameSite=Strict`, and the channel's trust layer refuses a
 * cross-site `Origin` before the body is read. The content-type check below is
 * defense in depth only.
 *
 * Every registration is an effect of this context, so plugin teardown removes the
 * routes even on a hot unload.
 *
 * @module dsh-session-retention/routes
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import {
  PreviewExpiredError, PreviewStaleError, SweepBusyError,
} from './sweep.ts'
import type {
  PreviewReport, PurgeReport, RetentionPolicy, RetentionSweep, SweepReport, TrashStats,
} from './sweep.ts'

/** The report read: its pathname below `/api`. */
export const REPORT_PATH = '/api/dsh-session-retention/report'

/** The bound delete: its pathname below `/api`. */
export const SWEEP_PATH = '/api/dsh-session-retention/sweep'

/** The explicit trash purge: its pathname below `/api`. */
export const PURGE_TRASH_PATH = '/api/dsh-session-retention/purge-trash'

/**
 * Methods registered on every fenced route.
 *
 * The channel matches a pathname first and a method second, so both verbs are
 * declared: each handler then answers the verb it does not implement with `405`
 * plus `Allow`, instead of the channel's blanket `404`, which would claim the
 * path does not exist.
 */
export const CHANNEL_METHODS: readonly ('GET' | 'POST')[] = ['GET', 'POST']

/** The six fields the page reads and writes, resolved from the live volatile config. */
export interface RouteConfig extends RetentionPolicy {
  /** Whether the periodic tick sweeps at all. */
  readonly autoSweep: boolean
  /** Minimum gap between two automatic sweeps, in hours. */
  readonly sweepIntervalHours: number
}

/**
 * Narrow the live configuration to the four fields the engine acts on.
 * @param config - the full live configuration.
 * @returns the policy the engine runs under.
 */
export function policyOf(config: RouteConfig): RetentionPolicy {
  return {
    retentionDays: config.retentionDays,
    dryRun: config.dryRun,
    trashGraceDays: config.trashGraceDays,
    maxMovesPerRun: config.maxMovesPerRun,
  }
}

/** The `GET report` payload. */
export interface ReportPayload {
  /** The live policy, echoed so the page renders what the Host actually runs. */
  readonly config: RouteConfig
  /** The last completed run, when one has completed since activation. */
  readonly lastReport?: SweepReport
  /** What the trash holds right now. */
  readonly trash: TrashStats
  /** The frozen review, present only for `?preview=1`. */
  readonly preview?: PreviewReport
}

/** The `POST sweep` payload. */
export interface SweepPayload {
  /** What the bound delete did. */
  readonly report: SweepReport
}

/** The `POST purge-trash` payload. */
export interface PurgePayload {
  /** What the purge reclaimed. */
  readonly purged: number
  /** Bytes the purge reclaimed. */
  readonly purgedBytes: number
  /** Present when the purge refused the trash root outright. */
  readonly refused?: string
}

/** Everything the routes answer from. */
export interface FencedRouteDeps {
  /** The sweep engine. */
  readonly engine: RetentionSweep
  /** The live configuration, read per request so a save applies at once. */
  readonly config: () => RouteConfig
}

/** One JSON answer. */
function json(status: number, payload: unknown, allow?: string): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }
  if (allow !== undefined) headers['allow'] = allow
  return new Response(JSON.stringify(payload), { status, headers })
}

/** One refusal in the plugin's own envelope. */
function refuse(status: number, code: string, message: string, allow?: string): Response {
  return json(status, { success: false, error: { code, message } }, allow)
}

/** One successful answer. */
function ok(data: unknown): Response {
  return json(200, { success: true, data })
}

/** One line of an error, safe to show an operator. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Map an engine refusal onto the wire.
 *
 * The two preview codes are distinct on purpose: `PREVIEW_STALE` means "the
 * candidate set moved, preview again", which the page recovers from by asking for
 * a fresh review, while `PREVIEW_EXPIRED` means the token is gone or was already
 * used. Neither ever re-scopes the delete silently.
 */
async function guarded(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof SweepBusyError) return refuse(409, 'SWEEP_BUSY', error.message)
    if (error instanceof PreviewStaleError) return refuse(409, 'PREVIEW_STALE', error.message)
    if (error instanceof PreviewExpiredError) return refuse(400, 'PREVIEW_EXPIRED', error.message)
    return refuse(500, 'SWEEP_FAILED', messageOf(error))
  }
}

/** Require a JSON object body, or answer the refusal. */
async function jsonBody(request: Request, path: string): Promise<Record<string, unknown> | Response> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('application/json')) {
    return refuse(415, 'UNSUPPORTED_MEDIA_TYPE', `${path} accepts application/json only`)
  }
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return refuse(400, 'INVALID_BODY', `${path} requires a JSON request body`)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refuse(400, 'INVALID_BODY', `${path} requires a JSON object request body`)
  }
  return body as Record<string, unknown>
}

/** The `GET report` route: the live policy, the last run, the trash, optionally a preview. */
function reportRoute(deps: FencedRouteDeps): ConnectionFetchRoute {
  return {
    path: REPORT_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'GET') {
        return refuse(405, 'METHOD_NOT_ALLOWED', `${request.method} is not implemented on ${REPORT_PATH}`, 'GET')
      }
      const wantsPreview = new URL(request.url).searchParams.get('preview') === '1'
      return await guarded(async () => {
        const config = deps.config()
        const trash = await deps.engine.trashStats()
        const lastReport = deps.engine.lastReport()
        const payload: ReportPayload = {
          config,
          trash,
          ...(lastReport === undefined ? {} : { lastReport }),
          ...(wantsPreview ? { preview: await deps.engine.preview(policyOf(config)) } : {}),
        }
        return ok(payload)
      })
    },
  }
}

/** The `POST sweep` route: move the reviewed set into the trash, oldest first. */
function sweepRoute(deps: FencedRouteDeps): ConnectionFetchRoute {
  return {
    path: SWEEP_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        return refuse(405, 'METHOD_NOT_ALLOWED', `${request.method} is not implemented on ${SWEEP_PATH}`, 'POST')
      }
      const body = await jsonBody(request, SWEEP_PATH)
      if (body instanceof Response) return body
      if (body.mode !== 'delete') {
        return refuse(400, 'INVALID_MODE', `${SWEEP_PATH} accepts {"mode":"delete","previewId":"..."}`)
      }
      const previewId = body.previewId
      if (typeof previewId !== 'string' || previewId.trim() === '') {
        return refuse(400, 'PREVIEW_REQUIRED', `${SWEEP_PATH} requires the previewId of a review this page showed`)
      }
      return await guarded(async () => {
        const config = deps.config()
        // An explicit delete is the operator's approved destructive step, so
        // `dryRun` — which gates AUTOMATIC runs — does not apply here.
        return ok({ report: await deps.engine.sweep(policyOf(config), { mode: 'sweep', previewId }) })
      })
    },
  }
}

/** The `POST purge-trash` route: reclaim everything past the grace window. */
function purgeTrashRoute(deps: FencedRouteDeps): ConnectionFetchRoute {
  return {
    path: PURGE_TRASH_PATH,
    methods: CHANNEL_METHODS,
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method !== 'POST') {
        return refuse(405, 'METHOD_NOT_ALLOWED', `${request.method} is not implemented on ${PURGE_TRASH_PATH}`, 'POST')
      }
      const body = await jsonBody(request, PURGE_TRASH_PATH)
      if (body instanceof Response) return body
      if (body.confirm !== true) {
        return refuse(400, 'CONFIRMATION_REQUIRED', `${PURGE_TRASH_PATH} requires {"confirm":true}`)
      }
      return await guarded(async () => {
        const purge: PurgeReport = await deps.engine.purgeTrash(policyOf(deps.config()))
        return ok(purge)
      })
    },
  }
}

/**
 * Register every fenced route this plugin publishes.
 * @param ctx - Host context owning the `connection` service.
 * @param deps - the engine and the live configuration read.
 */
export function registerFencedRoutes(ctx: Context, deps: FencedRouteDeps): void {
  for (const route of [reportRoute(deps), sweepRoute(deps), purgeTrashRoute(deps)]) {
    ctx.effect(() => {
      const dispose = ctx.connection.fetch.register(route)
      return () => { void dispose() }
    }, `dsh-session-retention: ${route.path}`)
  }
}
