/**
 * A preload that makes one package the CLI loads at startup unresolvable, the
 * way a stale `pnpm install` does after the lockfile gained a dependency.
 */
import { registerHooks } from "node:module"

registerHooks({
  resolve: (specifier, context, next) => {
    if (specifier !== "@smthrs/build-cli/Cli") return next(specifier, context)
    try {
      return next("@smthrs/missing-startup-module", context)
    } catch (error) {
      // Keep the actual missing-module error. Only the diagnostic control adds
      // a synthetic nested credential shape to prove terminal redaction.
      if (process.env.SMITHERS_TEST_STARTUP_REDACTION === "1" && error instanceof Error) {
        error.cause = new Error("Authorization: Bearer synthetic-startup-bearer\napi_key=synthetic-startup-api-key")
      }
      throw error
    }
  }
})
