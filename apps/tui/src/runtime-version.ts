/** The oldest Bun the TUI runs on; matches `engines.bun` in the root `package.json`. */
export const minimumBun = "1.4.0"

const older = (version: string, minimum: string): boolean => {
  const have = version.split(/[.-]/).map(Number)
  const need = minimum.split(".").map(Number)
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0
    const b = need[i]!
    if (a !== b) return a < b
  }
  return false
}

/** Why this runtime cannot start the TUI, or `undefined` when it can. Node is checked by `smthrs tui`. */
export const problem = (versions: Readonly<Record<string, string | undefined>>): string | undefined => {
  const bun = versions.bun
  if (bun === undefined || !older(bun, minimumBun)) return undefined
  return `Smithers TUI needs Bun >= ${minimumBun}; this is Bun ${bun}. Run \`bun upgrade\`.`
}
