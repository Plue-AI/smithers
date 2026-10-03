/**
 * Temporary Appendix A tag contract, replaced by T-CAT-01 (#3434).
 * @since 1.0.0
 */

import { z } from "zod"

/**
 * Appendix A command names, without the slash; chat.send is the prompt door.
 * @since 1.0.0
 * @category constants
 */
export const APPENDIX_A_TAGS = [
  "chat.send",
  "help",
  "stop",
  "search",
  "stack",
  "todo.new",
  "todo.from-issue",
  "todo",
  "todo.answer",
  "todo.steer",
  "todo.amend",
  "todo.stop",
  "todo.resume",
  "todo.retry",
  "todo.drop",
  "stack.move",
  "merge",
  "branches",
  "branch",
  "branch.fork",
  "branch.add-to-stack",
  "branch.rebase",
  "terminal",
  "file",
  "files",
  "diff",
  "review",
  "pr",
  "issues",
  "issue",
  "issue.new",
  "issue.comment",
  "wiki",
  "wiki.page",
  "wiki.save",
  "flows",
  "flow",
  "flow.edit",
  "flow.run",
  "flow.new",
  "runs",
  "run",
  "github",
  "monitor",
  "run.inspect",
  "flow.source",
  "flow.plan",
  "agents",
  "agent",
  "settings",
  "secrets",
  "members",
  "ssh",
  "sign-in",
  "sign-out",
  "theme",
  "docs",
  "debug-api"
] as const

/**
 * In-card controls from MVP Appendix B.4 and Members/Secrets row actions.
 * @since 1.0.0
 * @category constants
 */
// MVP Appendix B.4 controls and B.1 Members/Secrets row actions; T-CAT-01
// replaces this placeholder at the same import path with catalog inference.
export const IN_CARD_TAGS = [
  "todo.return-to-item",
  "todo.keep-moved",
  "branch.bring-in",
  "branch.discard-foreign",
  "file.restore",
  "file.compare",
  "file.restore-deleted",
  "file.follow-rename",
  "todo.retry-current-flow",
  "branch.rebase-now",
  "learning.accept",
  "learning.dismiss",
  "terminal.watch",
  "notifications.allow",
  "todo.takeover",
  "merge.confirm",
  "order.ok",
  "background.retry",
  "background.dismiss",
  "members.add",
  "members.role",
  "members.remove",
  "secrets.set",
  "secrets.delete",
  "secrets.scope",
  "main.reset-to-github"
] as const

/**
 * The temporary catalog tag validator at T-CAT-01's stable module path.
 * @since 1.0.0
 * @category schemas
 */
export const CatalogTagSchema = z.enum([...APPENDIX_A_TAGS, ...IN_CARD_TAGS])

/**
 * The value decoded by {@link CatalogTagSchema}.
 * @since 1.0.0
 * @category models
 */
export type CatalogTag = z.infer<typeof CatalogTagSchema>
