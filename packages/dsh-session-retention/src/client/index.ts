/**
 * Browser half: claim the row's configuration page on the Plugins panel.
 *
 * The bundle's patch inserts a row with a stable id, and the panel gives that row
 * a **Configure** control once a client half registers `plugins.row.config` under
 * `<package name>#<row id>`. That key is the whole coupling between the two
 * halves: the row id, the settings namespace, and the second half of this key are
 * all `dsh-session-retention`, and the panel resolves the Host form it supplies by
 * the bare row id — a row whose id is not unique in the composition gets no form
 * and therefore no page.
 *
 * `plugins.row.config` is the documented EXTERNAL surface for one row's
 * configuration: the panel supplies `form.state` and `form.mutate` rather than the
 * page owning a second write path, and the row's page is headed by the plugin's
 * localized title and description from `locale/en.json`. `plugins.item` is
 * reserved for the installation's own companion packages and `settings.section`
 * would put the page outside the Plugins panel.
 *
 * Every contribution is a Cordis effect, so a hot unload removes the dictionary,
 * the stylesheet and the page together.
 *
 * @module dsh-session-retention/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the `ctx.locale` service merge and the locale namespace map.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls `ctx.configForms`, whose `whileServed` gate tracks the Host's
// settings namespace, and the configuration-form contracts.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the `plugins.row.config` slot declaration and its owner props.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: pulls the `ctx.slots` service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { PAGE_LOCALE_NAMESPACE, SessionRetentionPage, installPageStyles } from './SessionRetentionPage.tsx'
import { en, zh } from './locales.ts'
import type { RetentionLocaleKey } from './locales.ts'

export type { SessionRetentionPageProps } from './SessionRetentionPage.tsx'
export type { RetentionLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-retention page copy. */
    dshSessionRetention: RetentionLocaleKey
  }
}

/** Services this half reads; all three are shell-provided. */
export const inject = ['slots', 'locale', 'configForms']

/** Package name: the first half of the row-config key the panel dispatches on. */
const PACKAGE_NAME = 'dsh-session-retention'

/** Row id the bundle patch inserts; it is also the settings namespace. */
const ROW_ID = 'dsh-session-retention'

/**
 * Register the dictionaries, the stylesheet, and the row's configuration page.
 * @param ctx - Browser-side plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(PAGE_LOCALE_NAMESPACE, { en, zh }), 'dsh-session-retention: dictionaries')
  ctx.effect(() => installPageStyles(), 'dsh-session-retention: styles')
  // The panel supplies the Host form only while it serves this row's settings
  // namespace, so the page registers under the same gate: a profile that does not
  // serve it shows no page rather than a page with no form.
  ctx.effect(
    () => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
      name: 'plugins.row.config',
      key: `${PACKAGE_NAME}#${ROW_ID}`,
      locale: PAGE_LOCALE_NAMESPACE,
    }, SessionRetentionPage))),
    'dsh-session-retention: page',
  )
}
