// Sandbox.run projection/capture helper; agents use the retained RemoteFix job.
import { Sandbox } from "@smthrs/sandbox"
import { Effect } from "effect"
import { AgentFailed, NoChange, type Remote } from "../work/flow.ts"

/**
 * Runs `body` on one machine from `provider` and answers its answer with the
 * work the machine's checkout gained, captured before the machine goes.
 * The work is measured from the commit the machine's checkout sat on once
 * acquired, which is never a commit the machine made, so the host resolves
 * it. A machine whose checkout ends where it started made no change, and
 * that is a failure.
 */
export const fixRemotely = <R>(
  provider: Sandbox.Provider,
  session: string,
  body: Effect.Effect<typeof Remote.Type, AgentFailed, R>
) =>
  Sandbox.run(provider, { session }, body).pipe(
    Effect.mapError((cause) =>
      cause instanceof AgentFailed ? cause : new AgentFailed({ message: `${session}: ${cause.message}` })
    ),
    Effect.flatMap((ran) =>
      ran.work._tag === "Unchanged"
        ? Effect.fail(
          new NoChange({
            message: `${ran.result.account} on ${session}: no change: ${
              ran.result.report.split("\n").slice(-5).join("\n")
            }`,
            account: ran.result.account,
            session,
            report: ran.result.report
          })
        )
        : Effect.succeed(ran)
    )
  )
