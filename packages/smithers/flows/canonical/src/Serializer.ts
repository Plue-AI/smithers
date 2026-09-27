/**
 * RFC 8785 serialization without importing the Effect schema or runtime.
 * These are the same functions and errors exported by the package root;
 * choosing this entry point does not change canonical bytes.
 *
 * @since 1.0.0
 */

export { CanonicalError, canonicalize } from "./internal/canonicalize.ts"
export type { CanonicalErrorCode } from "./internal/canonicalize.ts"
