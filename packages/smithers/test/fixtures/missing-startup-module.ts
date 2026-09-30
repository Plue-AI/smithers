/**
 * A preload that makes one package the CLI loads at startup unresolvable, the
 * way a stale `pnpm install` does after the lockfile gained a dependency.
 */
import { registerHooks } from "node:module"

registerHooks({
  resolve: (specifier, context, next) =>
    next(specifier === "@smthrs/build-cli/Cli" ? "@smthrs/missing-startup-module" : specifier, context)
})
