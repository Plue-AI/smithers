/**
 * The typed props and command callback seam between Views and Containers.
 * @since 1.0.0
 */

import { z } from "zod"
import { ModelIdSchema } from "./AgentRoles.ts"
import { ModelRoleIdSchema } from "./CardPrimitives.ts"
import { type CatalogTag, CatalogTagSchema } from "./catalog/index.ts"
import { ConfirmRevisionSchema } from "./ConfirmCard.ts"
import { DraftIdSchema } from "./DraftCard.ts"
export type { CatalogTag } from "./catalog/index.ts"

/**
 * An action form field.
 * @since 1.0.0
 * @category schemas
 */
export const FormFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  kind: z.enum(["text", "choice", "secret"]),
  choices: z.array(z.string()).optional(),
  required: z.boolean(),
  value: z.string().optional(),
  multiline: z.boolean().optional()
})

/**
 * The value decoded by {@link FormFieldSchema}.
 * @since 1.0.0
 * @category models
 */
export type FormField = z.infer<typeof FormFieldSchema>

/**
 * An action already filtered for the viewer by its Container. `args` are bound by the Container, such as
 * `{ n: "12", wait: "w-3" }`; the View passes them back unchanged with its form input.
 * @since 1.0.0
 * @category schemas
 */
export const ActionSchema = z.object({
  tag: CatalogTagSchema,
  label: z.string(),
  args: z.record(z.string(), z.string()).optional(),
  primary: z.boolean().optional(),
  disabled: z.object({ reason: z.string() }).optional(),
  input: z.array(FormFieldSchema).optional()
})

/**
 * The value decoded by {@link ActionSchema}.
 * @since 1.0.0
 * @category models
 */
export type Action = z.infer<typeof ActionSchema>

/**
 * `draft.discard` input: delete the author's uncommitted private Draft; it never drops a TODO. Author-only is
 * catalog policy (T-CAT-01), not an input field.
 * @since 1.0.0
 * @category schemas
 */
export const DraftDiscardInputSchema = z.object({ draft: DraftIdSchema })

/**
 * `confirm.cancel` input: cancel a pending confirmation at its revision. A stale revision is refused with the typed
 * `stale` refusal, which the server enforces. People only; there is no agent path (catalog policy).
 * @since 1.0.0
 * @category schemas
 */
export const ConfirmCancelInputSchema = z.object({ confirmation: z.string().min(1), revision: ConfirmRevisionSchema })

/**
 * `settings.model.set` input: set a role's model. `role` is the one model role enum (its `jev` id is shown as
 * "Decisions"); `model` is a catalog model id. Owner session only and agents never (catalog policy).
 * @since 1.0.0
 * @category schemas
 */
export const SettingsModelSetInputSchema = z.object({ role: ModelRoleIdSchema, model: ModelIdSchema })

/**
 * Provisional typed inputs from Appendix A arguments and component form fields; T-CAT-01 replaces these with descriptor inference.
 * @since 1.0.0
 * @category models
 */
export interface CardCommandInput {
  readonly "settings.address": { readonly listen: "mac" | "network"; readonly bind: string; readonly origins: readonly string[] }
  readonly "settings.capacity": { readonly capacity: number }
  readonly "settings.parallel": { readonly parallel: number }
  readonly "settings.model-key": { readonly role: "fast" | "coding" | "jev"; readonly provider: string }
  readonly "settings.setup": { readonly step: "address" | "app" | "sign_in" | "repository" | "models" | "source" | "machine"; readonly owner?: string; readonly repository?: string; readonly bind?: string; readonly origins?: readonly string[] }

  readonly "form.set": { readonly cardId: string; readonly field: string; readonly value: string }
  readonly "card.dismiss": { readonly cardId: string }
  readonly "chat.send": { readonly text: string }
  readonly "help": undefined
  readonly "stop": undefined
  readonly "search": { readonly query?: string }
  readonly "stack": undefined
  readonly "todo.new": { readonly text: string; readonly after?: number; readonly before?: number }
  readonly "todo.from-issue": { readonly number: number }
  readonly "todo": { readonly n: number }
  readonly "todo.answer": { readonly n: number; readonly answer: string; readonly wait?: string }
  readonly "todo.steer": { readonly n: number; readonly text: string }
  readonly "todo.amend": { readonly n: number; readonly text: string }
  readonly "todo.stop": { readonly n: number }
  readonly "todo.resume": { readonly n: number }
  readonly "todo.retry": { readonly n: number }
  readonly "todo.drop": { readonly n: number }
  readonly "stack.move": { readonly n: number; readonly direction: "up" | "down" }
  readonly "merge": { readonly n: number }
  readonly "branches": undefined
  readonly "branch": { readonly name: string }
  readonly "branch.fork": { readonly name?: string }
  readonly "branch.add-to-stack": { readonly text: string }
  readonly "branch.rebase": undefined
  readonly "terminal": undefined
  readonly "file": { readonly path: string }
  readonly "files": undefined
  readonly "diff": undefined
  readonly "review": undefined
  readonly "pr": { readonly number: number }
  readonly "issues": undefined
  readonly "issue": { readonly number: number }
  readonly "issue.new": { readonly title: string; readonly body: string }
  readonly "issue.comment": { readonly number: number; readonly body: string }
  readonly "wiki": undefined
  readonly "wiki.page": { readonly name: string }
  readonly "wiki.save": { readonly name: string }
  readonly "flows": undefined
  readonly "flow": { readonly name: string }
  readonly "flow.edit": { readonly name: string }
  readonly "flow.run": { readonly name: string; readonly input?: Readonly<Record<string, unknown>> }
  readonly "flow.new": { readonly name: string }
  readonly "runs": undefined
  readonly "run": { readonly id: string }
  readonly "github": undefined
  readonly "monitor": undefined
  readonly "run.inspect": { readonly id: string }
  readonly "flow.source": { readonly name: string }
  readonly "flow.plan": { readonly name: string }
  readonly "agents": undefined
  readonly "agent": { readonly name: string }
  readonly "settings": undefined
  readonly "secrets": undefined
  readonly "members": undefined
  readonly "ssh": { readonly branch: string }
  readonly "sign-in": undefined
  readonly "sign-out": undefined
  readonly "theme": undefined
  readonly "docs": { readonly page?: string }
  readonly "debug-api": undefined
  readonly "todo.return-to-item": { readonly n: number }
  readonly "todo.keep-moved": { readonly n: number }
  readonly "branch.bring-in": { readonly branch: string; readonly revision: string }
  readonly "branch.discard-foreign": { readonly branch: string; readonly revision: string }
  readonly "file.restore": { readonly path: string; readonly revision: string }
  readonly "file.compare": { readonly path: string }
  readonly "file.restore-deleted": { readonly path: string }
  readonly "file.follow-rename": { readonly path: string }
  readonly "todo.retry-current-flow": { readonly n: number }
  readonly "branch.rebase-now": { readonly branch: string }
  readonly "learning.accept": { readonly id: string }
  readonly "learning.dismiss": { readonly id: string }
  readonly "terminal.watch": { readonly id: string }
  readonly "notifications.allow": undefined
  readonly "todo.takeover": { readonly n: number }
  readonly "merge.confirm": { readonly n: number; readonly revision: string }
  readonly "order.ok": { readonly n: number }
  readonly "background.retry": { readonly id: string }
  readonly "background.dismiss": { readonly id: string }
  readonly "main.reset-to-github": { readonly revision: string }
  readonly "members.add": { readonly login: string; readonly role: "maintainer" | "member" }
  readonly "members.role": { readonly login: string; readonly role: "owner" | "maintainer" | "member" }
  readonly "members.remove": { readonly login: string }
  readonly "secrets.set": {
    readonly name: string
    readonly value: string
    readonly scope?: "all_branches" | "main_only"
  }
  readonly "secrets.delete": { readonly name: string }
  readonly "secrets.scope": { readonly name: string; readonly scope: "all_branches" | "main_only" }
  readonly "code.hover": { readonly path: string; readonly line: number; readonly col: number }
  readonly "code.definition": { readonly path: string; readonly line: number; readonly col: number }
  readonly "draft.discard": z.infer<typeof DraftDiscardInputSchema>
  readonly "confirm.cancel": z.infer<typeof ConfirmCancelInputSchema>
  readonly "settings.model.set": z.infer<typeof SettingsModelSetInputSchema>
}

/**
 * One callback per command, with that command's input and no RPC client.
 * @since 1.0.0
 * @category models
 */
export type CardCallbacks<Tag extends CatalogTag = CatalogTag> = {
  readonly [T in Tag]: (input: CardCommandInput[T]) => void
}

/**
 * The per-member view state every card has (spec §14.1.2).
 * @since 1.0.0
 * @category models
 */
export interface BaseView {
  readonly maximized: boolean
  readonly tab?: string
  readonly filter?: string
}

/**
 * Props-only card data, viewer-filtered buttons, named non-button gestures and per-member view state
 * (ui-components.md Shared types). `View` adds the card's own view fields; `Gesture` names its gestures.
 * A missing gesture does nothing.
 * @since 1.0.0
 * @category models
 */
export interface CardProps<Model, View extends object = {}, Gesture extends string = never> {
  readonly model: Model
  readonly actions: ReadonlyArray<Action>
  readonly gestures: Partial<Readonly<Record<Gesture, Action>>>
  readonly onAction: (tag: CatalogTag, input?: Record<string, string>) => void
  readonly view: BaseView & View
  readonly onView: (patch: Partial<BaseView & View>) => void
}
