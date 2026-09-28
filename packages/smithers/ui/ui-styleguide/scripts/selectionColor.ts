/**
 * The upstream `terminal.selectionBackground`, only when it is a 6- or 8-digit
 * hex color; anything else (missing, or a string a compromised theme release
 * put there) becomes `fallback`. Terminal consumers read it as a color, so an
 * unchecked string would flow straight into their rendering.
 */
export function selectionColor(value: string | null | undefined, fallback: string): string {
  return value && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value) ? value : fallback;
}
