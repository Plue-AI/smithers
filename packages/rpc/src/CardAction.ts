/**
 * The typed props and command callback seam between Views and Containers.
 * @since 1.0.0
 */

import { z } from "zod"
import { type CatalogTag, CatalogTagSchema } from "./catalog/index.ts"
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
 * An action already filtered for the viewer by its Container.
 * @since 1.0.0
 * @category schemas
 */
export const ActionSchema = z.object({
  tag: CatalogTagSchema,
  label: z.string(),
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
 * Provisional typed inputs from Appendix A arguments and component form fields; T-CAT-01 replaces these with descriptor inference.
 * @since 1.0.0
 * @category models
 */
export interface CardCommandInput {
  readonly "chat.send": { readonly text: string }
  readonly "help": undefined
  readonly "stop": undefined
  readonly "search": { readonly query?: string }
  readonly "stack": undefined
  readonly "todo.new": { readonly text: string; readonly after?: number; readonly before?: number }
  readonly "todo.from-issue": { readonly number: number }
  readonly "todo": { readonly n: number }
  readonly "todo.answer": { readonly n: number; readonly answer: string }
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
  readonly "docs": undefined
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
 * Props-only card data, action gestures, and per-member presentation.
 * @since 1.0.0
 * @category models
 */
export interface CardProps<Model> {
  readonly model: Model
  readonly actions: ReadonlyArray<Action>
  readonly onAction: (tag: CatalogTag, input?: Record<string, string>) => void
  readonly view: { readonly maximized: boolean; readonly tab?: string; readonly filter?: string }
  readonly onView: (patch: Partial<CardProps<Model>["view"]>) => void
}
