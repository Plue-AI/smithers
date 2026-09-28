/**
 * The structural slice of a just-bash interpreter.
 *
 * @since 1.0.0-rc.0
 */

/**
 * The slice of a `just-bash` interpreter instance this module depends on.
 *
 * Satisfied by the `Bash` class exported from the **`just-bash`** npm package
 * (`new Bash({ fs })`), whose method is
 * `exec(commandLine: string, options?: ExecOptions): Promise<BashExecResult>`
 * (3.2.0, `dist/Bash.d.ts`). Only the members this adapter touches are
 * declared, under their real names: `cwd`, `env`, `replaceEnv`, and `signal`
 * from `ExecOptions`, and `stdout`/`stderr`/`exitCode` from the result. The
 * real `ExecOptions` also carries a string `stdin`, which this adapter does
 * not use.
 *
 * **The returned promise must settle after `signal` aborts.** Runs are
 * serialized so two interpreters never mutate the mount at once, and the
 * serialization permit is held until the promise settles: an implementation
 * that ignores the abort and never resolves blocks every later run rather
 * than being abandoned mid-write. Rejecting with `signal.reason` is the
 * expected answer.
 *
 * **The interpreter's own environment is ambient.** A command without `env`
 * runs with whatever environment the page constructed the interpreter with,
 * so every command can read it. Never seed credentials into it.
 *
 * We take an instance rather than the package so the browser bundle owns
 * construction — mounting the interpreter on the *same* virtual filesystem
 * `BrowserFileSystem` adapts — and so tests can hand us a stub.
 *
 * @category models
 * @since 1.0.0-rc.0
 * @slop
 */
export interface JustBashLike {
  /** Run a command line to completion through the interpreter and return its captured result. */
  readonly exec: (
    commandLine: string,
    options?: {
      readonly cwd?: string
      readonly env?: Record<string, string>
      /**
       * Asks the interpreter to run with `env` alone rather than merging it
       * into the interpreter's current environment. Effect's
       * `CommandOptions.env` is a replacement unless `extendEnv: true` is set,
       * so the adapter asks for it whenever the caller did not ask to extend.
       */
      readonly replaceEnv?: boolean
      readonly signal?: AbortSignal
    }
  ) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>
}
