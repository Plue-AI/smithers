/**
 * The generator copies `terminal.selectionBackground` from `@shikijs/themes`.
 * A compromised release must not put an arbitrary string into the terminal
 * palette, so only hex colors pass and anything else takes the fallback.
 */
import { expect, test } from "bun:test";
import { selectionColor } from "../scripts/selectionColor.ts";

const fallback = "rgba(43,108,176,0.3)";

test("keeps the hex selection colors upstream ships", () => {
  for (const value of ["#acb0be", "#abb2bf30", "#1B90DD4D"]) expect(selectionColor(value, fallback)).toBe(value);
});

test("replaces a missing or non-hex selection color with the fallback", () => {
  for (
    const value of [undefined, null, "", "url(//evil.example/t)", "\u001b]52;c;cHduZWQ=\u0007", "#abc", "#abb2bf30;x", "red"]
  ) {
    expect(selectionColor(value, fallback)).toBe(fallback);
  }
});
