/**
 * One prerendered diff block, split into what every block repeats and what is
 * unique to this one.
 *
 * @since 1.0.0
 * @category models
 */
export type DiffAssets = {
  sprite: string;
  styles: string[];
  body: string;
};

/**
 * Split a prerendered @pierre/diffs HTML block into its shared assets and the
 * per-diff body. Every block ships the same SVG sprite sheet and component
 * stylesheets, so a page embedding many diffs should keep one copy of the
 * assets and concatenate only the bodies.
 *
 * Pierre scopes its theme variables to `:host` (it targets shadow DOM); in
 * light DOM those variables never resolve and the diff tinting is invisible.
 * The returned styles are therefore rescoped from `:host` to `.pierre-diff`,
 * and consumers MUST wrap each body in `<div class="pierre-diff">…</div>`.
 * Only the style assets are transformed; the body is returned byte-for-byte,
 * so code that happens to contain the text ":host" is never touched.
 *
 * The sprite is returned empty when the body contains no `<use` reference
 * (with disableFileHeader nothing references it), so callers can skip the
 * ~8KB of dead markup; when a body does reference it, it is returned so the
 * page can inline it once.
 */
export function extractDiffAssets(prerenderedHTML: string): DiffAssets {
  const firstStyle = prerenderedHTML.indexOf("<style");
  if (firstStyle < 0) return { sprite: "", styles: [], body: prerenderedHTML };
  const sprite = prerenderedHTML.slice(0, firstStyle);
  const styles: string[] = [];
  let rest = prerenderedHTML.slice(firstStyle);
  while (rest.startsWith("<style")) {
    const end = rest.indexOf("</style>");
    if (end < 0) break;
    styles.push(rest.slice(0, end + "</style>".length).replaceAll(":host", ".pierre-diff"));
    rest = rest.slice(end + "</style>".length);
  }
  return { sprite: rest.includes("<use") ? sprite : "", styles, body: rest };
}
