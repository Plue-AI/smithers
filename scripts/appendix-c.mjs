/** Shared Appendix C table reader. Titles and classification come from the product appendix. */
export const parseAppendixC = (source) => {
  const rows = new Map()
  for (const line of source.split(/\r?\n/)) {
    if (!line.startsWith("| `")) continue
    const cells = line.split(/(?<!\\)\|/).slice(1, -1).map(cell => cell.trim().replace(/\\\|/g, "|"))
    if (cells.length !== 7) throw new Error(`Invalid Appendix C row: ${line}`)
    const match = /^`([^`]+)`$/.exec(cells[0])
    if (!match) throw new Error(`Invalid Appendix C tag: ${cells[0]}`)
    const tag = match[1], title = cells[6]
    if (cells[5] !== "Keep" || title === "-" || title.startsWith("Each tool call")) continue
    const previous = rows.get(tag)
    if (previous !== undefined && previous !== title) throw new Error(`Conflicting Appendix C title for ${tag}`)
    rows.set(tag, title)
  }
  if (rows.size === 0) throw new Error("Appendix C has no Keep titles")
  return Object.fromEntries([...rows].sort(([a], [b]) => a.localeCompare(b, "en")))
}
