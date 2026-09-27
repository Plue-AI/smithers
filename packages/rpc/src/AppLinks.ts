/**
 * Native application download and handoff link contracts.
 *
 * @since 1.0.0
 */

/**
 * Where the web app sends a visitor for the native app.
 *
 * Null until a native build is published: no `apps-v*` release carries a
 * downloadable asset, so there is nothing to link and the app renders no
 * download door (apps/app/docs/web-mode/PLAN.md §3: the download page renders
 * only rows present in the release manifest). Whoever uploads the first
 * artifact stamps the URL here in the same commit — the native download page
 * once `apps/site` serves it, else the `apps-v*` GitHub Release.
 *
 * @since 1.0.0
 * @category constants
 */
export const DOWNLOAD_URL: string | null = null
