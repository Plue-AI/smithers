/**
 * The TypeScript configuration filename rule shared by detection, archiving,
 * and postconditions.
 *
 * @since 1.0.0-rc.0
 * @private
 */

/**
 * Whether a project path names a TypeScript configuration.
 *
 * @since 1.0.0-rc.0
 * @private
 */
export const isTsconfig = (file: string): boolean => /(^|\/)tsconfig[^/]*\.json$/.test(file)
