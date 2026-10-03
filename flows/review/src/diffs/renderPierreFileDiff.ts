import { preloadPatchDiff } from "@pierre/diffs/ssr"

/**
 * A per-line annotation slot to prerender into the diff. For each entry the
 * static HTML gains, directly after the matching line's content row, a
 * `<div data-line-annotation><div data-annotation-content><slot
 * name="annotation-{side}-{lineNumber}"></slot></div></div>` block (plus a
 * matching gutter spacer). In light DOM a `<slot>` renders its children, so a
 * consumer can inject finding markup by filling that uniquely named slot.
 */
export type PierreDiffAnnotation = {
  side: "additions" | "deletions"
  lineNumber: number
}

/**
 * Render one file's git patch to Pierre-quality static HTML: syntax
 * highlighting (light/dark token variables), word-level diffs, line numbers,
 * unified or split view. Defaults to themeType "system" so the output carries
 * both light and dark tokens and follows the page's color-scheme. The result
 * is self-contained (inline styles + SVG sprite); use extractDiffAssets to
 * hoist the shared assets when embedding many diffs in one page.
 */
export async function renderPierreFileDiff(args: {
  diff: string
  diffStyle?: "unified" | "split"
  themeType?: "light" | "dark" | "system"
  annotations?: Array<PierreDiffAnnotation>
}): Promise<string> {
  const result = await preloadPatchDiff({
    patch: args.diff.endsWith("\n") ? args.diff : `${args.diff}\n`,
    options: {
      diffStyle: args.diffStyle ?? "unified",
      themeType: args.themeType ?? "system",
      disableFileHeader: true
    },
    ...(args.annotations === undefined ? {} : { annotations: args.annotations })
  })
  return result.prerenderedHTML
}
