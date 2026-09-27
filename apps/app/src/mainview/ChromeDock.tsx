import { useLiveQuery } from "@tanstack/react-db"
import { BookOpen,Download,History,Inbox,KeyRound,MessagesSquare,Moon,RotateCcw,Sun,Timer,UserRound,Users,Workflow } from "lucide-react"
import { useController } from "./ControllerContext"
import { flowAction } from "./flows/FlowAction"

/*
 * The dock: the chrome as a vertical icon rail on the left edge, always on
 * screen — no sidebar, no drawer, no toggle. The order is the factory
 * design session's (mocks ~/Desktop/smithers-factory/factory-mocks.html):
 * Wiki, Dispatcher, Flows, Secrets, History, Account; the admin reset and
 * the theme toggle close the column. Each button is the button door of one
 * registered flow and renders exactly where that flow registers.
 */
export function ChromeDock() {
  const controller = useController()
  const { data: sessionRows } = useLiveQuery((q) =>
    q.from({ session: controller.store.collections.sessions }).select(({ session }) => ({
      id: session.id,
      theme: session.theme
    }))
  )
  const dark = sessionRows[0]?.theme === "dark"
  // The web app's door to the native app (docs/web-mode/PLAN.md §3): registered on the cloud host only, and
  // rendered only while a native release exists to download (AppLinks.ts — null until one carries an asset).
  const canDownload = controller.commands.find("app.download") !== undefined && controller.downloadUrl !== null
  // Wiki: the `wiki` surface switch (the Wiki pane beside the chat); registered on every host.
  const canWiki = controller.commands.find("wiki") !== undefined
  // Dispatcher: triggers.list, the dispatcher card.
  const canDispatcher = controller.commands.find("triggers.list") !== undefined
  // Flows: the `flows` surface switch; registered on every host.
  const canFlows = controller.commands.find("flows") !== undefined
  // Secrets: secrets.list, registered on the cloud host only.
  const canSecrets = controller.commands.find("secrets.list") !== undefined
  // History: history.show, the History card: the mythical stack is the repository history (D-20).
  const canHistory = controller.commands.find("history.show") !== undefined
  // Account (factory mock 21): account.show, registered where an identity seam exists.
  const canAccount = controller.commands.find("account.show") !== undefined
  // Inbox (DESIGN §3.4): approvals.list, the one place the person answers things; cloud hosts only.
  const canInbox = controller.commands.find("approvals.list") !== undefined
  // Conversations (DESIGN §3.1): issues.list narrowed to conversations (a conversation is an issue).
  const canConversations = controller.commands.find("issues.list") !== undefined
  // Agents (DESIGN §3.3): agent.list, the configured agent profiles.
  const canAgents = controller.commands.find("agent.list") !== undefined
  // Admin chrome follows the same capability-filtered registry as every act.
  const isAdmin = controller.commands.find("admin.devtools") !== undefined

  return (
    <nav className="chrome-dock" aria-label="Chrome" data-testid="chrome-actions">
      {/* The click is the human's gesture window.open needs; the model renders the card (app.download.prompt) instead. */}
      {canDownload ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Download the app"
            title="Download the app"
            data-testid="chrome-download"
            {...flowAction(controller.runCommand, "app.download")}
          >
            <Download size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Wiki: the button door of the `wiki` surface switch; the pane opens beside the chat, signed in or out. */}
      {canWiki ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Wiki"
            title="Wiki"
            data-testid="chrome-wiki"
            {...flowAction(controller.runCommand, "wiki")}
          >
            <BookOpen size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Inbox: the button door of approvals.list. */}
      {canInbox ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Inbox"
            title="Inbox"
            data-testid="chrome-inbox"
            {...flowAction(controller.runCommand, "approvals.list")}
          >
            <Inbox size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Conversations: the button door of issues.list --kind conversation. */}
      {canConversations ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Conversations"
            title="Conversations"
            data-testid="chrome-conversations"
            {...flowAction(controller.runCommand, "issues.list", "open --kind conversation")}
          >
            <MessagesSquare size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Agents: the button door of agent.list. */}
      {canAgents ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Agents"
            title="Agents"
            data-testid="chrome-agents"
            {...flowAction(controller.runCommand, "agent.list")}
          >
            <Users size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Dispatcher: the button door of triggers.list; readable signed out from the declaration on the public mirror. */}
      {canDispatcher ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Dispatcher"
            title="Dispatcher"
            data-testid="chrome-dispatcher"
            {...flowAction(controller.runCommand, "triggers.list")}
          >
            <Timer size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Flows: the button door of the `flows` surface switch; signed out the pane states that flows run on your own workspace. */}
      {canFlows ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Flows"
            title="Flows"
            data-testid="chrome-flows"
            {...flowAction(controller.runCommand, "flows")}
          >
            <Workflow size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Secrets: the button door of secrets.list; signed out, the run path defers it behind the sign-in step. */}
      {canSecrets ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Secrets"
            title="Secrets"
            data-testid="chrome-secrets"
            {...flowAction(controller.runCommand, "secrets.list")}
          >
            <KeyRound size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* History: the button door of history.show; signed out, the flow parks behind sign-in. */}
      {canHistory ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="History"
            title="History"
            data-testid="chrome-history"
            {...flowAction(controller.runCommand, "history.show")}
          >
            <History size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* Account: the button door of account.show; signed out, the same flow renders the sign-in step. */}
      {canAccount ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Account"
            title="Account"
            data-testid="chrome-account"
            {...flowAction(controller.runCommand, "account.show")}
          >
            <UserRound size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      {/* The bare reset is admin-only dev tooling (§2); users get /clear. */}
      {isAdmin ?
        (
          <button
            type="button"
            className="chrome-icon-action"
            aria-label="Reset conversation"
            title="Reset conversation"
            {...flowAction(controller.runCommand, "admin.reset.ask")}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </button>
        ) :
        null}
      <button
        type="button"
        className="chrome-icon-action"
        aria-label="Toggle light and dark mode"
        title="Toggle light and dark mode"
        {...flowAction(controller.runCommand, "appearance.dark-mode")}
      >
        {dark ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
      </button>
    </nav>
  )
}
