/**
 * Progressive-disclosure projections for registry entries.
 *
 * XML output follows the XML 1.0 character repertoire with a stricter
 * noncharacter rule. Forbidden C0 controls, lone surrogates, U+FDD0 through
 * U+FDEF, and every plane's U+FFFE and U+FFFF positions are replaced with
 * U+FFFD. Tab, line feed, carriage return, and valid astral characters are
 * preserved.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */

import type { FlowDescriptor } from "./Descriptor.ts"

const isXmlCharacter = (codePoint: number): boolean =>
  codePoint === 0x09 ||
  codePoint === 0x0a ||
  codePoint === 0x0d ||
  (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
  (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
  (codePoint >= 0x10000 && codePoint <= 0x10ffff)

const isNoncharacter = (codePoint: number): boolean =>
  (codePoint >= 0xfdd0 && codePoint <= 0xfdef) || (codePoint & 0xffff) >= 0xfffe

const replaceForbiddenXmlCharacters = (value: string): string => {
  let output = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    output += isXmlCharacter(codePoint) && !isNoncharacter(codePoint) ? character : "\uFFFD"
  }
  return output
}

/**
 * Escapes text for use as XML character data.
 *
 * @since 0.1.0
 * @category utilities
 */
const escapeXml = (value: string): string =>
  replaceForbiddenXmlCharacters(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;")

/**
 * Projects descriptors into slash-autocomplete entries.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toEntries = (
  entries: ReadonlyArray<FlowDescriptor>
): ReadonlyArray<{ readonly name: string; readonly description: string }> =>
  entries
    .map(({ name, description }) => ({ name, description }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

/**
 * Renders model-invocable descriptors as an agentskills-style XML block.
 * XML 1.0-forbidden characters and Unicode noncharacters are replaced with
 * U+FFFD before XML metacharacters are escaped, so one malformed descriptor
 * cannot invalidate the catalog.
 *
 * @since 0.1.0
 * @category conversions
 */
export const toXml = (entries: ReadonlyArray<FlowDescriptor>): string => {
  const visible = toEntries(entries.filter((entry) => entry.modelInvocable))

  if (visible.length === 0) {
    return "<available_skills>\n</available_skills>"
  }

  return [
    "<available_skills>",
    ...visible.flatMap(({ name, description }) => [
      "  <skill>",
      `    <name>${escapeXml(name)}</name>`,
      `    <description>${escapeXml(description)}</description>`,
      "  </skill>"
    ]),
    "</available_skills>"
  ].join("\n")
}
