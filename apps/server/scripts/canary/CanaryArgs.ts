/*
 * One flag reader for every canary command shell.
 *
 * The shells (build-probe, uptime-probe, uptime-report, rollback-probe) all take `--name value` options, and each one used to
 * redeclare the same `indexOf(name) + 1` lookup. Only one of those copies
 * refused to read a following flag as a value, so `--json --samples 3` wrote a
 * report to a file called "--samples" and `--sha --max-drift 3` graded the
 * deployment against the string "--max-drift". A parser fix reached one shell
 * and left the others wrong.
 *
 * Everything here is a total function of its arguments; `argReader` is the one
 * place a shell's exit policy meets it.
 */

/**
 * What one `--name` lookup found. `no-value` is deliberately not folded into
 * `absent`: a flag the operator passed but left empty is a mistake in this
 * invocation, and silently defaulting it hides that.
 */
export type FlagRead =
  | { readonly state: "absent" }
  | { readonly state: "value"; readonly value: string }
  | { readonly state: "no-value"; readonly detail: string }

export const readFlag = (argv: ReadonlyArray<string>, name: string): FlagRead => {
  const at = argv.indexOf(name)
  if (at === -1) return { state: "absent" }
  const value = argv[at + 1]
  if (value === undefined) {
    return { state: "no-value", detail: `${name} needs a value, and nothing follows it` }
  }
  if (value.startsWith("--")) {
    return {
      state: "no-value",
      detail: `${name} needs a value, but it is followed by ${value}: a flag is never read as another flag's value`
    }
  }
  return { state: "value", value }
}

/**
 * Bind `readFlag` to one shell's refusal. `refuse` is the shell's own "print
 * and exit" — the message wording and the exit code stay with the command that
 * owns them — so a missing value stops the run before any fetch or file write,
 * rather than being defaulted away.
 */
export const argReader = (
  argv: ReadonlyArray<string>,
  refuse: (detail: string) => never
) =>
(name: string): string | undefined => {
  const read = readFlag(argv, name)
  if (read.state === "no-value") return refuse(read.detail)
  return read.state === "value" ? read.value : undefined
}

/*
 * Split a comma- or newline-separated login roster, dropping blanks and `#`
 * comments. Splitting on spaces too would quietly turn a malformed entry into
 * several well-formed ones, which is how a bad roster passes validation.
 */
export const parseLogins = (raw: string | undefined): ReadonlyArray<string> => {
  if (raw === undefined) return []
  return raw
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("#"))
}
