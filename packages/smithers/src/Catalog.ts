/**
 * The generated product catalog, shared by transport adapters. Operation
 * descriptors in the UI package remain the sole declaration authority.
 *
 * @since 1.0.0
 */

import type { CatalogHttpBinding } from "./CatalogRequest.ts"
import * as CatalogData from "./internal/backend/catalog.mvp.json" with { type: "json" }

const catalog = CatalogData.default

/**
 * One generated operation, including its payload and actor policy.
 * @category models
 * @since 1.0.0
 */
export interface CatalogDescriptor {
  readonly name: string
  readonly slash: string | null
  readonly cli: ReadonlyArray<string> | null
  readonly actors: ReadonlyArray<string>
  readonly visibility: string
  readonly group: string
  readonly agent: string
  readonly minimumRole: string
  readonly summary: string
  readonly payload: {
    readonly schema: Readonly<Record<string, unknown>>
    readonly definitions?: Readonly<Record<string, unknown>>
  }
  readonly http: CatalogHttpBinding | null
}

/**
 * Packaged descriptors; repository files never override this catalog.
 * @category constants
 * @since 1.0.0
 */
export const catalogDescriptors: ReadonlyArray<CatalogDescriptor> = catalog.operations as ReadonlyArray<
  CatalogDescriptor
>
