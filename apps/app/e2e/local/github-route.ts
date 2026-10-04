import type { BrowserContext } from "@playwright/test"

export const isManifest = (method: string, url: string): boolean => {
  const u = new URL(url)
  return method === "POST" && u.origin === "https://github.com" && /^\/(organizations\/[^/]+\/)?settings\/apps\/new$/.test(u.pathname)
}

// Only the provider's manifest page is missing an existing configurable base.
export async function githubRoute(context: BrowserContext, fakeURL: string) {
  const aborted: string[] = [], routed: string[] = []
  await context.route(/^https?:\/\/([a-z0-9-]+\.)*(github\.com|githubusercontent\.com)([:/]|$)/i, async route => {
    const request = route.request(), u = new URL(request.url())
    if (isManifest(request.method(), request.url())) {
      routed.push(`${request.method()} ${u.pathname}`)
      const response = await route.fetch({ url: fakeURL + u.pathname + u.search, maxRedirects: 0 })
      await route.fulfill({ response })
    } else {
      aborted.push(`${request.method()} ${u.origin}${u.pathname}`)
      await route.abort()
    }
  })
  return { aborted, routed }
}
