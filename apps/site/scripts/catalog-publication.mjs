/**
 * Reports where a page presents a package the release does not publish as one
 * a reader can install.
 *
 * A manifest's `private` flag keeps a package off npm, and the roster in
 * `scripts/pack-release.mjs` decides what a release train packs. A catalog that
 * gives a package its own heading, or an install command, promises both. This
 * reads the roster instead of restating it, so a package leaving the train
 * reddens the page that still sells it.
 *
 * @since 1.0.0
 */

/** A heading or table row that opens with the package name, linked to its documentation. */
const packageHeading = /^(?:#{2,6} |\| )\[`?(@smthrs\/[a-z0-9-]+)`?\]/gm

/** An install command a reader can paste, in any of the package managers the docs use. */
const installCommand = /(?:npm (?:install|i|add)|pnpm (?:add|install)|bun (?:add|install)|yarn add)[^\n`]*?(@smthrs\/[a-z0-9-]+)/g

/**
 * @param {string} page raw page source, fences included
 * @param {{ manifests: Map<string, { private?: boolean }>, roster: Set<string> }} tree
 * @returns {Array<string>} one message per violation, in page order
 */
export function catalogPublicationErrors(page, { manifests, roster }) {
  const errors = []
  // Fences are examples, not prose: a label has to be readable beside the name.
  const noFences = page.replace(/```[\s\S]*?```/g, "")
  const published = (name) => roster.has(name) && manifests.get(name)?.private !== true
  const labelled = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`\`${escaped}\`[^\n]*workspace-private|workspace-private[^\n]*\`${escaped}\``).test(noFences)
  }
  for (const [, name] of noFences.matchAll(packageHeading)) {
    if (!manifests.has(name)) {
      errors.push(`heads a section with ${name}, which is not a package in this repo`)
      continue
    }
    if (published(name) && labelled(name)) errors.push(`${name} is in the release roster; the page marks it workspace-private`)
    if (!published(name) && !labelled(name)) {
      errors.push(`${name} is not in the release roster; the page heads a section with it without labelling it workspace-private`)
    }
  }
  for (const [, name] of page.matchAll(installCommand)) {
    if (!published(name)) errors.push(`teaches installing ${name}, which the release roster does not publish`)
  }
  return [...new Set(errors)]
}
