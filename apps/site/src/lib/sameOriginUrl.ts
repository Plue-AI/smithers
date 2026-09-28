/**
 * Resolve a URL read from a fetched page against that page's address and
 * answer it only when it stays on `origin`. The home page imports the app's
 * island chunk and stylesheets named by the prerendered app page; a
 * cross-origin chunk would run in this origin, so it is refused.
 */
export function sameOriginUrl(raw: string, base: string, origin: string): string {
  const url = new URL(raw, base)
  if (url.origin !== origin) throw new Error(`The app page names a cross-origin resource: ${url.origin}.`)
  return url.href
}
