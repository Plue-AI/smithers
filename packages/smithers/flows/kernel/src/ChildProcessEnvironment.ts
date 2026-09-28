/**
 * Least-authority environment construction for child processes.
 *
 * @since 1.0.0-rc.0
 */

/**
 * Credential-bearing field names shared with the model request boundary.
 *
 * `token`, `key` (optionally followed by a separated `id`), and `pat` are
 * anchored to complete or separator-delimited suffixes so names such as
 * `TOKEN_COUNT` and `KEYBOARD` remain ordinary diagnostics. Keeping this rule
 * below the model and process layers gives request validation and child
 * spawning one definition of a sensitive name.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const credentialNamePattern =
  /authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|api[-_]?token|session[-_]?token|bearer|(?:^|[-_])token$|(?:^|[-_])key(?:[-_]id)?$|(?:^|[-_])pat$|secret|credential|password|passphrase|passwd|signature|x-amz-signature|cookie|set[-_]?cookie|chatgpt[-_]?account[-_]?id/i

/**
 * Reports whether a field name conventionally carries credentials.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const isCredentialName = (name: string): boolean => credentialNamePattern.test(name)

/**
 * Ambient variables a child may inherit for executable lookup, identity,
 * locale, terminal behavior, temporary files, and its shell.
 *
 * Locale category variables are admitted separately by their `LC_` prefix.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const inheritedNames: ReadonlyArray<string> = Object.freeze([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "TMPDIR",
  "SHELL"
])

const inherited = new Set(inheritedNames)

/**
 * Reports whether a variable belongs to the bootstrap set {@link make}
 * inherits: one of {@link inheritedNames} or a locale `LC_` category,
 * compared case-insensitively.
 *
 * @category predicates
 * @since 1.0.0-rc.1
 */
export const isInheritedName = (name: string): boolean => {
  const canonical = name.toUpperCase()
  return inherited.has(canonical) || canonical.startsWith("LC_")
}

const remove = (environment: Record<string, string>, name: string): void => {
  const canonical = name.toUpperCase()
  for (const present of Object.keys(environment)) {
    if (present.toUpperCase() === canonical) delete environment[present]
  }
}

/**
 * Selects the bootstrap allowlist from an ambient environment and overlays
 * caller-declared names.
 *
 * Sensitive-looking ambient names are withheld even if a future bootstrap
 * list grows to include one. A caller declaration is applied last because it
 * is the explicit authority for that child; an `undefined` declaration
 * removes an inherited name. The returned null-prototype record is always
 * suitable as a replacement environment and never asks the spawner to merge
 * the rest of the host process environment.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (
  ambient: Readonly<Record<string, string | undefined>>,
  declared: Readonly<Record<string, string | undefined>> = {}
): Record<string, string> => {
  const environment = Object.create(null) as Record<string, string>
  for (const [name, value] of Object.entries(ambient)) {
    if (value !== undefined && isInheritedName(name) && !isCredentialName(name)) environment[name] = value
  }
  for (const [name, value] of Object.entries(declared)) {
    remove(environment, name)
    if (value !== undefined) environment[name] = value
  }
  return environment
}
