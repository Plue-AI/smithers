/**
 * Rendering a verification command as the shell line the prompt and the report
 * show, and as the `proc:spawn` resource the kernel checks when it runs.
 *
 * `@smthrs/kernel/CommandLine.render` produces the line and
 * `@smthrs/kernel/CommandLine.resource` produces the grant resource. The
 * kernel is a flow-lane dependency the scan surface must never load
 * (`test/Dependencies.test.ts`), so this module is the scan-side copy of the
 * pure rules the kernel applies to the commands `Verify` spawns: an argv
 * renders every token quoted, and a `shell: true` line holding control syntax
 * is checked as `sh -c '<line>'`. `test/flow/DerivedCommands.test.ts` pins
 * that the two renderers agree, so a grant written from here is the resource
 * the kernel checks.
 *
 * @since 1.0.0-rc.0
 */

/** Tokens made only of these characters need no quoting in a POSIX shell. */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * Quotes one token for a POSIX shell, leaving obviously safe tokens alone.
 * Identical to `@smthrs/kernel/CommandLine.quote`.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const quote = (token: string): string =>
  token !== "" && SAFE.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`

/**
 * Renders an executable and its literal arguments the way the kernel renders
 * a command it spawns with no shell: every token POSIX-quoted.
 *
 * @category rendering
 * @since 1.0.0-rc.0
 */
export const renderArgv = (executable: string, args: ReadonlyArray<string>): string =>
  [executable, ...args].map(quote).join(" ")

/** Shell syntax that chains, substitutes, groups, or redirects. Identical to the kernel's. */
const shellControl = /[;&|`$<>()\n\r]/

/** An fd duplication or a discard to `/dev/null`, which the kernel does not count as control syntax. */
const harmlessRedirect = /(^|\s)(?:\d*>&\d+|\d*>[ \t]*\/dev\/null)(?=\s|$)/g

/**
 * The `proc:spawn` resource the kernel checks for a line it spawns with
 * `shell: true`, in the project root and with no environment overrides: the
 * line itself, or `sh -c '<line>'` when the line holds shell control syntax.
 * Mirrors `@smthrs/kernel/CommandLine.resource`.
 *
 * @category rendering
 * @since 1.0.0-rc.1
 */
export const shellResource = (line: string): string =>
  shellControl.test(line.replace(harmlessRedirect, "$1")) ? `sh -c ${quote(line)}` : line
