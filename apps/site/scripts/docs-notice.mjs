import { defineRouteMiddleware } from "@astrojs/starlight/route-data"

export const onRequest = defineRouteMiddleware(({ locals }, next) => {
  locals.starlightRoute.entry.data.banner ??= {
    content: 'These docs describe the unpublished Smithers 1.0 release candidate. <a href="https://github.com/smithersai/smithers/blob/main/packages/smithers/docs/installation.md#install-the-cli">Install it from the source checkout</a>.'
  }
  return next()
})
