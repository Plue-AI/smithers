import { Action, FlowRuntime, Interpreter } from "@smthrs/flow"
import { EngineStore } from "@smthrs/flows"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { NodeHost, HostLiveness } from "../../smithers/flows/platform-node/src/index.ts"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { mkdir, chmod } from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import * as Slack from "../../smithers/agent/integrations/src/slack/IssueSync.ts"
import * as SlackActions from "../../smithers/agent/integrations/src/slack/Actions.ts"
import * as Connections from "../../smithers/agent/integrations/src/slack/Connections.ts"
import * as SocketSource from "../../smithers/agent/integrations/src/slack/SocketSource.ts"
import * as SlackSync from "../../smithers/agent/integrations/src/slack/Sync.ts"
import * as Telegram from "../../smithers/agent/integrations/src/telegram/IssueSync.ts"
import * as TelegramActions from "../../smithers/agent/integrations/src/telegram/Actions.ts"
import * as TelegramClient from "../../smithers/agent/integrations/src/telegram/TelegramClient.ts"
import * as TelegramSource from "../../smithers/agent/integrations/src/telegram/Source.ts"
import * as CursorStore from "../../smithers/agent/integrations/src/core/CursorStore.ts"
import * as Migrations from "../../smithers/agent/integrations/src/core/Migrations.ts"

const Strings = Schema.Array(Schema.NonEmptyString)
export const Configuration = Schema.Struct({
  owner: Schema.NonEmptyString,
  repo: Schema.NonEmptyString,
  slack: Schema.optional(Schema.Struct({ teamIds: Strings, channelIds: Strings, userIds: Strings })),
  telegram: Schema.optional(Schema.Struct({ botId: Schema.NonEmptyString, chatIds: Strings, userIds: Strings }))
})
export type Configuration = typeof Configuration.Type

export const openHost = async (options: {
  config: Configuration
  stateRoot: string
  env: Readonly<Record<string, string | undefined>>
  request: (path: string, init?: RequestInit) => Promise<Response>
}) => {
  const { config, env, stateRoot, request } = options
  if (!Schema.is(Configuration)(config) || (!config.slack && !config.telegram)) throw new Error("Invalid chat connector configuration")
  if (!isAbsolute(stateRoot)) throw new Error("Chat connectors require an absolute durable state directory")
  if (config.slack && config.slack.channelIds.length === 0) throw new Error("Slack requires explicit channel or DM conversation IDs for outbound access")
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await chmod(stateRoot, 0o700)
  const workspaceRoot = join(stateRoot, "workspace")
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 })
  if (config.slack && !env.SMITHERS_SLACK_APP_TOKEN) throw new Error("Slack Socket Mode requires an app credential")
  const slack = config.slack ? Connections.fromEnvironment({ containers: config.slack.channelIds }, env) : undefined
  const telegram = config.telegram ? TelegramClient.make({ apiBaseUrl: env.SMITHERS_TELEGRAM_API_BASE_URL }, env) : undefined
  const registration = Layer.mergeAll(
    Interpreter.layer(Slack.Post), Interpreter.layer(Slack.Update), Interpreter.layer(Slack.Delete),
    Interpreter.layer(Slack.React), Interpreter.layer(Slack.Reconcile),
    Interpreter.layer(Telegram.Post), Interpreter.layer(Telegram.Update), Interpreter.layer(Telegram.Delete),
    Interpreter.layer(Telegram.React)
  ).pipe(
    Layer.provideMerge(SlackActions.layer),
    Layer.provideMerge(TelegramActions.layerIssueSync(() => telegram ? Effect.succeed(telegram) : Effect.die("Telegram is not configured"))),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(CursorStore.layerSql.pipe(Layer.provideMerge(Migrations.layer)))
  )
  const owner = { hostId: "chat-connectors" }
  const managed = ManagedRuntime.make(NodeRuntime.layer({
    filename: join(stateRoot, "engine.sqlite"), workspaceRoot, owner,
    isAlive: HostLiveness.isAlive(owner)
  }, EngineStore.StepBoundary.layer, EngineStore.WorkspaceSandbox.layerFileSystem(), registration).pipe(
    Layer.provide(Layer.mergeAll(NodeHost.layerAt(workspaceRoot), NodeHost.NodeCrypto.layer, Connections.layer(slack ? [slack] : [])))
  ))
  try {
    const runtime = await managed.runPromise(FlowRuntime.FlowRuntime)
    const common = { owner: config.owner, repo: config.repo, request, runtime }
    const slackPolicy = config.slack ? {
      allowedTeamIds: config.slack.teamIds, allowedChannelIds: config.slack.channelIds, allowedUserIds: config.slack.userIds
    } : undefined
    const bridges: Array<{ drain: () => Promise<number>; run: Effect.Effect<void, unknown, CursorStore.CursorStore> }> = []
    if (slack && slackPolicy) {
      const bridge = Slack.make({ ...common, connectionId: "slack", policy: slackPolicy })
      // Messages sent while no socket was open are read back from history first.
      // The narrowest type avoids a conversations.info scope; access scope is unused here.
      const startAt = SlackSync.msToTs(Date.now())
      const feeds = slackPolicy.allowedChannelIds.map(channel => SlackSync.make({
        connectionId: "slack", channel, client: slack.client, initialOldest: startAt,
        channelType: channel.startsWith("D") ? "im" : "private"
      }))
      const catchUp = slack.client.call("auth.test").pipe(
        Effect.flatMap(auth => bridge.catchUp({ teamId: String(auth["team_id"]), feeds }))
      )
      bridges.push({
        drain: bridge.drain,
        run: Effect.andThen(catchUp, bridge.run(SocketSource.make({ client: slack.client, policy: slackPolicy })))
      })
    }
    if (telegram && config.telegram) {
      const bridge = Telegram.make({ ...common, connectionId: "telegram", botId: config.telegram.botId, allowedChatIds: config.telegram.chatIds, allowedUserIds: config.telegram.userIds })
      bridges.push({ drain: bridge.drain, run: bridge.run(TelegramSource.make({ client: telegram, allowedChatIds: config.telegram.chatIds, allowedUpdates: Telegram.ALLOWED_UPDATES })) })
    }
    return {
      durability: runtime.durability,
      // Admission is already durably committed by the issue API using the
      // provider event identity. The factory consumes those same issues.
      drain: async () => {
        let count = 0
        for (const bridge of bridges) count += await bridge.drain()
        return count
      },
      run: (signal?: AbortSignal) => managed.runPromise(Effect.all(bridges.map(bridge => bridge.run), { concurrency: "unbounded" }), { signal }),
      close: () => managed.dispose()
    }
  } catch (error) {
    await managed.dispose()
    throw error
  }
}
