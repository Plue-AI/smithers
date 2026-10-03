/** Frozen admission rule for retained modules using the removed Core constructor. */
export const isLegacyObjectModule = (bytes: Uint8Array): boolean => {
  const source = new TextDecoder().decode(bytes)
  const aliases: Array<string> = []
  for (
    const match of source.matchAll(
      /import\s+(?:\*\s+as\s+(\w+)\s+from\s+["']@smthrs\/core\/Flow["']|\{([^}]+)\}\s+from\s+["']@smthrs\/core["'])/g
    )
  ) {
    const named = match[2]?.match(/(?:^|,)\s*Flow(?:\s+as\s+(\w+))?\s*(?:,|$)/)
    const alias = match[1] ?? (named === undefined || named === null ? undefined : named[1] ?? "Flow")
    if (alias !== undefined) aliases.push(alias)
  }
  return aliases.some((alias) => new RegExp(`\\b${alias}\\.make\\s*\\(\\s*\\{`).test(source))
}
