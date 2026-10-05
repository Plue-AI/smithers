import { z } from "zod"

/**
 * Schema for .specs/product/features.json, the registry of every feature the
 * MVP supports and the recorded proof that it works.
 *
 * Restored from 2716e98558^:.smithers/lib/ddd/featuresSchema.ts and adapted to
 * the evidence contract's entry shape (f6-briefs/EVIDENCE-CONTRACT.md): one
 * entry per feature, linked to the design mock's steps, the e2e proof steps,
 * the docs and the code on main.
 */

/** `implemented` only when every proof step passed in the latest recorded run; anything else, partial included, is `not-implemented`. */
export const featureStatusSchema = z.enum(["implemented", "not-implemented"])

/** Kebab-case, stable across edits: the page, the proof steps and the screenshots key on it. */
export const featureIdSchema = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "id must be kebab-case (a-z, 0-9, single -)")

/** `<journey file>#<n>`, n 1-based, into apps/app/proof/mock-steps.json. */
export const mockStepRefSchema = z.string().regex(/^[a-z0-9-]+#[1-9][0-9]*$/, "mock step must be <journey file>#<n>, n 1-based")

/** A repository-relative path with no leading slash, no `..` segment and no backslash. */
const repoPath = z
  .string()
  .min(1)
  .refine(path => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !path.split("/").includes("."), "path must be repository-relative")

/** A path plus an optional `#anchor` (a spec or docs heading). */
export const anchoredPathSchema = z.string().refine(value => repoPath.safeParse(value.split("#", 1)[0]).success, "path must be repository-relative, with an optional #anchor")

/** A path plus an optional `#L<a>-L<b>` line range (a <= b), rendered as a GitHub permalink at the recorded commit. */
export const codeRefSchema = z
  .string()
  .regex(/^[^#]+(#L[1-9][0-9]*-L[1-9][0-9]*)?$/, "code must be <path> or <path>#L<a>-L<b>")
  .refine(value => repoPath.safeParse(value.split("#", 1)[0]).success, "code path must be repository-relative")
  .refine(value => {
    const range = parseCodeRef(value).range
    return range === undefined || range.start <= range.end
  }, "line range must not run backwards")

/** One recorded proof: a Playwright `proofStep` named by the feature id in a proof spec. */
export const proofSchema = z.object({ file: repoPath, step: featureIdSchema }).strict()

export const featureSchema = z
  .object({
    id: featureIdSchema,
    title: z.string().min(1),
    journey: z.string().regex(/^(J[0-9]+|[a-z][a-z0-9-]*)$/, "journey is J<n> or a mock journey file name"),
    spec: anchoredPathSchema,
    mockSteps: z.array(mockStepRefSchema),
    status: featureStatusSchema,
    proof: z.array(proofSchema),
    docs: z.array(anchoredPathSchema),
    code: z.array(codeRefSchema),
    /** One line: what fails or is missing. Empty when implemented. */
    gap: z.string().refine(gap => !gap.includes("\n"), "gap is one line")
  })
  .strict()

export const featuresSchema = z.array(featureSchema)

export type FeatureStatus = z.infer<typeof featureStatusSchema>
export type FeatureProof = z.infer<typeof proofSchema>
export type Feature = z.infer<typeof featureSchema>

/** Splits `path#La-Lb` into its path and line range. */
export function parseCodeRef(value: string): { readonly path: string; readonly range?: { readonly start: number; readonly end: number } } {
  const [path = "", anchor] = value.split("#", 2)
  const match = anchor === undefined ? null : /^L([0-9]+)-L([0-9]+)$/.exec(anchor)
  return match === null ? { path } : { path, range: { start: Number(match[1]), end: Number(match[2]) } }
}

/** Splits `<journey file>#<n>`. */
export function parseMockStepRef(value: string): { readonly journey: string; readonly n: number } {
  const [journey = "", n = "0"] = value.split("#", 2)
  return { journey, n: Number(n) }
}
