/**
 * Public declarations for the CLI's single-instance Effect resolver.
 *
 * @since 0.1.0
 */

/**
 * Installs the remaining ESM identity/bootstrap resolvers and tsx's supported
 * ESM loader once. Explicit declaration imports register a namespaced
 * CommonJS bridge; ordinary CommonJS dependencies use Node resolution.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const installEffectResolution: (packages?: Readonly<Record<string, string>>) => void

/**
 * Evaluates one declaration module through tsx with the CLI's resolver in
 * front of tsx's namespace loader, so the module and the CLI share one Effect
 * instance.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const importDeclarationModule: (url: string, parentURL: string) => Promise<unknown>

/**
 * Marks one admitted declaration URL for ES-module evaluation.
 *
 * @category loading
 * @since 0.1.0
 * @slop
 */
export declare const buildModuleUrl: (url: string) => string
