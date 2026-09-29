/**
 * Encrypted local credentials; command output contains references only.
 *
 * @since 1.0.0
 */

import * as Credential from "@smthrs/control/Credential"
import * as CredentialCipher from "@smthrs/control/CredentialCipher"
import * as SqlCredentialStore from "@smthrs/control/SqlCredentialStore"
import * as WebCryptoCipher from "@smthrs/control/WebCryptoCipher"
import { Effect, Redacted } from "effect"
import { Cli, z } from "incur"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as Presentation from "../cli/Presentation.ts"
import * as CliError from "../CliError.ts"
import { databaseLayer, localFields, type LocalOptions, localRoot } from "./Store.ts"

/** An operator request this command refuses; the operator fixes the input or the host setup. */
const refused = (message: string, fault: CliError.Fault = "user"): CliError.Refused =>
  new CliError.Refused({ fault, code: "operator_failed", message })

// Every operator command reports failures as operator_failed.
const execute = <A>(context: Presentation.Failing, body: () => Promise<A>) =>
  Presentation.guard(context, body, {
    code: "operator_failed",
    next: Presentation.runs({
      otherwise: [{ command: "credentials list", description: "Inspect credential metadata without revealing secrets" }]
    })
  })

/**
 * Selects exactly one source for a credential secret.
 * @category models
 * @since 1.0.0
 */
export interface SecretOptions {
  readonly secretEnv?: string | undefined
  readonly secretFile?: string | undefined
}

/**
 * Reads a credential without exposing it through command output.
 * @category constructors
 * @since 1.0.0
 */
export const readSecret = (options: SecretOptions, root: string): Redacted.Redacted<string> => {
  if ((options.secretEnv === undefined) === (options.secretFile === undefined)) {
    throw refused("Supply exactly one of --secret-env or --secret-file")
  }
  let secret: string | undefined
  if (options.secretEnv !== undefined) secret = process.env[options.secretEnv]
  else {
    try {
      secret = readFileSync(resolve(root, options.secretFile!), "utf8").replace(/\r?\n$/, "")
    } catch {
      throw refused("Could not read --secret-file")
    }
  }
  if (secret === undefined || secret.length === 0) throw refused("The selected secret source is empty or missing")
  return Redacted.make(secret)
}

/**
 * Runs an operation against the authoritative encrypted credential store.
 * @category constructors
 * @since 1.0.0
 */
export const withCredentials = <A, E>(
  options: LocalOptions,
  operation: (service: Credential.Credential) => Effect.Effect<A, E>,
  needsKey = false
): Promise<A> => {
  const root = localRoot(options)
  const key = process.env["SMITHERS_CREDENTIAL_KEY"]
  if (
    needsKey && (key === undefined || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").byteLength !== 32)
  ) {
    throw refused("Set SMITHERS_CREDENTIAL_KEY to a base64-encoded 32-byte encryption key")
  }
  return Effect.runPromise(
    Effect.gen(function*() {
      const store = yield* SqlCredentialStore.make
      const cipher = needsKey ? yield* WebCryptoCipher.make({ key: Redacted.make(key!) }) : CredentialCipher.makeNoop()
      return yield* operation(Credential.make({ store, cipher }))
    }).pipe(Effect.provide(databaseLayer(root)))
  )
}

/** CLI fields shared by add and rotate. */
const secretFields = {
  secretEnv: z.string().optional().describe("Environment variable containing the secret"),
  secretFile: z.string().optional().describe("File containing the secret; one trailing newline is removed")
}

/**
 * Builds the local credential administration command group.
 * @category constructors
 * @since 1.0.0
 */
export const createCredentialsCli = () =>
  Cli.create("credentials", { description: "Manage encrypted local credentials without printing secret values" })
    .command("list", {
      description: "List credential IDs and connection names",
      mcp: { annotations: { readOnlyHint: true } },
      options: z.object(localFields),
      run: (context) => execute(context, () => withCredentials(context.options, (service) => service.list()))
    })
    .command("add", {
      description: "Encrypt a credential using SMITHERS_CREDENTIAL_KEY",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ id: z.string().min(1) }),
      options: z.object({ ...localFields, ...secretFields, name: z.string().min(1) }),
      run: (context) =>
        execute(context, () => {
          const secret = readSecret(context.options, localRoot(context.options))
          return withCredentials(context.options, (service) =>
            service.create({ id: context.args.id, name: context.options.name, secret }), true)
        })
    })
    .command("rotate", {
      description: "Replace an encrypted credential secret using a compare-and-set write",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ id: z.string().min(1) }),
      options: z.object({ ...localFields, ...secretFields }),
      run: (context) =>
        execute(context, () => {
          const secret = readSecret(context.options, localRoot(context.options))
          return withCredentials(context.options, (service) =>
            service.get(context.args.id).pipe(Effect.flatMap((reference) =>
              service.rotate(reference, secret)
            )), true)
        })
    })
    .command("revoke", {
      description: "Remove a stored credential reference and its encrypted secret",
      mcp: { annotations: { readOnlyHint: false } },
      args: z.object({ id: z.string().min(1) }),
      options: z.object(localFields),
      run: (context) =>
        execute(context, () =>
          withCredentials(context.options, (service) =>
            service.get(context.args.id).pipe(
              Effect.flatMap((reference) => service.revoke(reference)),
              Effect.as({ id: context.args.id, revoked: true })
            )))
    })
