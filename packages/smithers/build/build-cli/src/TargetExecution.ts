/**
 * The shared runtime for executing a target declaration's own Effect body.
 *
 * Specialized rules may use native implementations, while every other target
 * settles through this exact stack.
 *
 * @since 0.1.0
 */

import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import { ExecIrreversibleLive } from "@smthrs/targets/Changesets"
import { GenerateCheckLive } from "@smthrs/targets/Compose"
import { CheckDocsLive } from "@smthrs/targets/DocsParity"
import * as Exec from "@smthrs/targets/Exec"
import type * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import { ExpandFilegroupLive } from "@smthrs/targets/Filegroup"
import { CheckFileLive, WriteFileLive } from "@smthrs/targets/GeneratedFile"
import { LlmReviewLive } from "@smthrs/targets/LlmLint"
import { ScaffoldPackageLive } from "@smthrs/targets/NewPackage"
import { SyncPackageJsonLive } from "@smthrs/targets/PackageJson"
import * as Target from "@smthrs/targets/Target"
import { CaptureOutputsLive } from "@smthrs/targets/ToolBuild"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as NodePath from "node:path"
import {
  declaredToolchain,
  layerInstall,
  layerNonInteractiveNodeServices,
  layerPackageManager,
  targetToolchain,
  verifyTargetToolchain
} from "./engine.ts"
import { FactoryProjectionLive } from "./FactoryProjectionExec.ts"
import type * as OutputStream from "./OutputStream.ts"
import type * as Planner from "./Planner.ts"

/**
 * Executes one target body in a fresh in-memory Flow runtime.
 *
 * @category execution
 * @since 0.1.0
 */
export const runTarget = (
  workspaceRoot: string,
  cacheDirectory: string,
  target: Target.AnyTarget,
  attrs: unknown,
  executionId: string,
  sensitiveEnv: ReadonlyArray<string>,
  packageName?: string | undefined,
  nixEnvironment?: Planner.PlannedEnvironment | undefined,
  sandbox?: ExecSandbox.Request | undefined,
  output?: OutputStream.Observer | undefined
): Effect.Effect<unknown, unknown> =>
  Effect.suspend(() => {
    // Decode and lower before acquiring services or probing executables. The
    // exact validated attrs select both the action plan and its tool checks.
    const validated = Target.metadata(target).attrsSchema.make(attrs, {
      parseOptions: { onExcessProperty: "error" }
    })
    const planned: Node.Node<unknown, unknown, never> = Target.plan(target, validated)
    if (typeof validated !== "object" || validated === null) throw new TypeError("target attrs must be a record")
    const flow = Flow.make(target._tag, {
      payload: {},
      success: Schema.Unknown,
      error: Schema.Unknown,
      body: () => planned
    })
    const environment: Exec.ToolEnvironment | undefined = nixEnvironment === undefined
      ? undefined
      : { path: nixEnvironment.path.join(NodePath.delimiter), variables: nixEnvironment.variables }
    const cwd = Exec.resolveWorkspacePath(
      workspaceRoot,
      "cwd" in validated && typeof validated.cwd === "string" ? validated.cwd : "."
    )
    const declared = targetToolchain(target._tag, validated)
    const declaredEnvironment = declared.runtime === undefined && declared.packageManager === undefined
      ? {}
      : Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
        "env" in validated ? validated.env ?? {} : {}
      )
    const hostEnvironment = Exec.toolEnvironment(declaredEnvironment, sensitiveEnv, {}, environment)
    const runtime = Layer.mergeAll(
      layerInstall,
      Exec.ExecLive({ workspaceRoot, cacheDirectory, sensitiveEnv, environment, sandbox, ...output }),
      GenerateCheckLive({ workspaceRoot, cacheDirectory, sensitiveEnv, environment }),
      ExecIrreversibleLive({ workspaceRoot }),
      CaptureOutputsLive({ workspaceRoot, cacheDirectory }),
      ExpandFilegroupLive({ workspaceRoot, cacheDirectory }),
      WriteFileLive({ workspaceRoot }),
      CheckFileLive({ workspaceRoot }),
      CheckDocsLive({ workspaceRoot }),
      FactoryProjectionLive({ workspaceRoot }),
      LlmReviewLive({
        workspaceRoot,
        sensitiveEnv,
        store: { directory: NodePath.resolve(workspaceRoot, cacheDirectory, "review-findings") }
      }),
      SyncPackageJsonLive({ workspaceRoot, cacheDirectory }),
      ScaffoldPackageLive({ workspaceRoot, packageName }),
      Target.layerNotImplemented,
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(
        layerPackageManager(
          workspaceRoot,
          declaredToolchain({ runtime: declared.runtime, packageManager: declared.packageManager }),
          sensitiveEnv,
          hostEnvironment
        )
      ),
      Layer.provideMerge(layerNonInteractiveNodeServices)
    )
    return verifyTargetToolchain(declared, cwd, hostEnvironment, sensitiveEnv).pipe(
      Effect.andThen(flow.execute({}, { executionId })),
      Effect.provide(runtime)
    )
  })
