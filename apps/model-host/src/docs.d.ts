/** The in-app docs pages build.mjs bundles from apps/app/src/docs, in table-of-contents order. */
declare module "smithers:docs" {
  import type { DocsPage } from "@smthrs/rpc/DocsPages"
  export const docs: ReadonlyArray<DocsPage>
}
