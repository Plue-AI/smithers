import { Facet } from "@codemirror/state"
import type { Actor } from "@smthrs/rpc/CardPrimitives"

export interface AuthorRange { readonly from: number; readonly to: number; readonly actor: Actor }
/** Presentation consumes attribution; these ranges never grant write authority. */
export const authorRanges = Facet.define<readonly AuthorRange[], readonly AuthorRange[]>({ combine: values => values.flat() })
