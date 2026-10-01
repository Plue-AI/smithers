import { describe,expect,test } from "bun:test"
import { readdirSync,readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"

/*
 * The launch-law gate: every interactive affordance in the app routes through
 * the command registry (`runCommand`), never a direct
 * controller call. This test enumerates the action props in every surface
 * file and asserts each one either dispatches through the registry itself or
 * is a delegated prop whose binding site does. Adding a button without a
 * command behind it fails this test.
 */

const read = (relative: string): string => {
  let source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
  // Inspect the shared bindings (flows/FlowAction.ts) as the JSX they spell
  // out, keeping every existing command and affordance check applicable to
  // both binding spellings — the attribute is written in one place now, so a
  // literal `data-flow="…"` no longer appears in a surface file at all.
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const edits: Array<{ start: number; end: number; text: string }> = []
  /** The attribute this call spells out, as JSX: `"x.y"` stays a literal, anything else stays an expression. */
  const attribute = (prop: string, node: ts.Expression): string =>
    `${prop}=${ts.isStringLiteral(node) ? JSON.stringify(node.text) : `{${node.getText(tree)}}`}`
  const visit = (node: ts.Node) => {
    if (ts.isJsxSpreadAttribute(node) && ts.isCallExpression(node.expression)) {
      const callee = node.expression.expression.getText(tree)
      const written = (text: string) => edits.push({ start: node.getStart(tree), end: node.end, text })
      if (callee === "flowAction" || callee === "dynamicFlowAction") {
        const [run, name, args] = node.expression.arguments
        if (!run || !name) throw new Error("A flow binding needs its dispatcher and command")
        written(`${attribute("data-flow", name)} onClick={() => ${run.getText(tree)}(${name.getText(tree)}${args ? `, ${args.getText(tree)}` : ""})}`)
      } else if (callee === "flowProps" || callee === "dynamicFlowProps") {
        const [name] = node.expression.arguments
        if (!name) throw new Error("A flow binding needs its command")
        written(attribute("data-flow", name))
      } else if (callee === "flowGestureProps") {
        const [name, activate] = node.expression.arguments
        if (!name || !activate) throw new Error("A gesture binding needs its rest and activation commands")
        written(`${attribute("data-flow", name)} ${attribute("data-flow-activate", activate)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
  return source
}

/**
 * The registry source: the Flows.ts aggregator, every namespace module under
 * ./entries and every shared operation module (`@smthrs/ui/app-operations`),
 * read together so a flow declared in any module counts.
 */
const registrySources = (): string => {
  const entries = fileURLToPath(new URL("./entries/", import.meta.url))
  const shared = fileURLToPath(new URL(".", import.meta.resolve("@smthrs/ui/app-operations")))
  return [
    read("./Flows.ts"),
    ...readdirSync(entries).sort().map((file) => read(`./entries/${file}`)),
    ...readdirSync(shared).sort().map((file) => readFileSync(`${shared}${file}`, "utf8"))
  ].join("\n")
}

/**
 * Every component file under src/mainview, discovered rather than listed: a new
 * surface added with a command-less button has to fail this gate, and a
 * hand-maintained list would silently exempt it.
 */
const surfaceFiles = (): Array<string> => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
    .map((entry) => `../${entry.split("\\").join("/")}`)
    .sort()
}

const ACTION_PROPS = ["onClick", "onSubmit", "onStop", "onConfirm", "onDecide", "onSelect", "onClose"] as const

interface HandlerRef {
  readonly prop: string
  /** The line the action prop appears on. */
  readonly line: string
  readonly context: string
}

/**
 * Inspect the complete JSX handler; focus handoffs can precede the command.
 * A handler passed as a property of an `actions` object (FailureNotice's
 * `actions={{ retry: { onClick } }}`) is a button too.
 */
const handlers = (source: string): Array<HandlerRef> => {
  const tree = ts.createSourceFile("surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = source.split("\n")
  const found: Array<HandlerRef> = []
  const isAction = (name: string) => ACTION_PROPS.includes(name as typeof ACTION_PROPS[number])
  const insideActions = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
      if (ts.isJsxAttribute(parent)) return parent.name.getText(tree) === "actions"
    }
    return false
  }
  const visit = (node: ts.Node) => {
    const named = ts.isJsxAttribute(node) ||
      ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) &&
        insideActions(node))
    if (named && isAction(node.name.getText(tree))) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line
      found.push({ prop: node.name.getText(tree), line: lines[line]!, context: node.getText(tree) })
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/** Literal JSX bindings, excluding comments, text, and selectors used to find controls. */
const literalBindings = (source: string): Array<{ readonly prop: string; readonly name: string }> => {
  const tree = ts.createSourceFile("surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Array<{ readonly prop: string; readonly name: string }> = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node)) {
      const prop = node.name.getText(tree)
      if (prop === "data-flow" || prop === "closeCommand") {
        const value = node.initializer && ts.isJsxExpression(node.initializer)
          ? node.initializer.expression : node.initializer
        if (value && (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))) {
          found.push({ prop, name: value.text })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return found
}

/**
 * Handlers that legitimately do NOT dispatch a command, with the reason each
 * is not a launch-law violation. Anything not listed here MUST route through
 * the registry.
 */
const PRESENTATION_ONLY = [
  "setSlashMenu", // slash-menu hover highlight: local presentation state
  "setTag(", // wiki tree tag filter: which tag narrows the tree — local presentation state
  "fileInput.current?.click()", // wiki attach: opening the file dialog is the human's gesture; the chosen file rides wiki.attach through its gesture
  "setCopied", // copy feedback flash; the clipboard write routes via onCopy
  "setSelectedPath", // world card doc selection: which note the embedded editor shows — local presentation state
  "onDismissDrawer(", // graph card detail drawer close: local presentation state (which node is focused)
  "setOpenLog(", // run timeline log panel: which row's log is open — local presentation state
  "setUncapped(", // burndown card: a long group shown past its embedded cap — local presentation state; maximized shows every row
  "setAsking(", // burndown card: whether its stop/resume question is open — local presentation state; the acts ride flow.run.stop / runs.signal / issue-sweep
  "onKeep}", // burndown card: closing that question — local presentation state
  "setDeleteDraft", // workspace card delete: the typed-confirm row's open state and its draft — local presentation state; the act itself rides box.delete
  "onRunCommand(", // delegated: App.tsx binds it to the registry's runCommand
  "onChoose(", // delegated: Composer.tsx routes a palette row through runCommand, or edits the draft (a namespace, a prefix)
  // Card maximize/minimize: each calls the delegated onMaximize/onMinimize (bound to card.maximize /
  // card.minimize at the App.tsx and CardTabBody binding sites) and then hands focus to the button
  // that replaces the one pressed, so Escape keeps a shell to land on.
  "maximizeThenFocus",
  "minimizeThenFocus",
  "openNamespace", // slash-menu namespace draft edit
  "onCopy(", // delegated: TranscriptMessage.tsx binds it to runCommandForResult("chat.copy-message", ...)
  "onDownload}", // delegated: TranscriptMessage.tsx binds StorageRecoveryButton to storage.recovery.export
  "onDecideApproval(", // delegated: App.tsx binds it to approval.approve / approval.deny
  "onRecoAction(", // delegated: App.tsx binds it to reco.accept / reco.edit / reco.dismiss
  "onGrantConfirm(", // delegated: App.tsx binds it to admin.grant.confirm
  "onGrantCancel(", // delegated: App.tsx binds it to admin.grant.cancel
  "onDismiss(", // delegated: App.tsx binds it to runCommand("toast.dismiss", ...)
  "onMaximize(", // delegated: App.tsx binds it to runCommand("card.maximize", ...)
  "onMinimize(", // delegated: App.tsx binds it to card.minimize
  "onFrameBack", // delegated: App.tsx binds it to frame.back
  "onFrameForward", // delegated: App.tsx binds it to frame.forward
  "onForkFrame", // delegated: App.tsx binds it to frame.fork
  "onOpenInTab(", // delegated: App.tsx and tabs/CardTabBody.tsx bind it to runCommand("tab.card", ...)
  "onInstall(", // delegated: PluginsSurface.tsx bind it to runCommand("plugins.install", ...)
  "onRemove(", // delegated: PluginsSurface.tsx binds it to runCommand("plugins.remove", ...)
  "onOpen(", // delegated: the plugin rail's binding sites bind it to runCommand(<the entry's own flow>)
  "onConnectGitHub(", // delegated: App.tsx binds it to auth.sign-in
  "onRunWorkflow(", // delegated: App.tsx binds it to runCommand("flow.run", ...)
  "onStopRun(", // delegated: App.tsx binds it to runCommand("flow.run.stop", ...)
  "onRetryRun(", // delegated: App.tsx binds it to runCommand("flow.run.retry", ...)
  "onChooseWorkflowRepo(", // delegated: App.tsx binds it to runCommand("flow.repo.choose", ...)
  "onConfirm}", // SurfaceChrome delegates to its binding site
  "onCancel}", // dismissing a dialog changes no application state
  "onClose}", // SurfaceChrome delegates to its binding site
] as const

// Indirections added with the run cards. Scope each literal
// to its component so a similarly named handler cannot inherit the exception.
const DELEGATED_HANDLERS: Readonly<Record<string, readonly string[]>> = {
  // Pre-boot browser navigation: no writable store/controller exists here.
  // Choosing this document's writer is a human tab gesture, not an app command.
  // The human credential continuation opened by auth.sign-in. Passwords stay
  // in the form and its auth controller, outside the command journal.
  "../LocalAuthPanel.tsx": ["onSubmit={submit}", "close(event.currentTarget.ownerDocument)", "onClick: () => auth.open()"],
  // Bootstrap recovery runs before a controller exists. Backend selection
  // stays in the boot adapter; its credential must never enter a command journal.
  "../AppRoot.tsx": ["onClick={() => window.location.reload()}"], // saved-store failure blocks the command journal; Reload reopens storage
  "../StartupError.tsx": [
    "onClick={useSmithersHere}", "onClick={() => window.location.reload()}", "onClick: () => window.location.reload()",
    "onClick={() => setChoosing(true)}", "await switchBackend(origin, token)"
  ],
  "../ToastAction.tsx": ["onAction(action)"], // ToastStack/App bind the typed action to runCommand(action.flow, action.args)
  "../HelpBubble.tsx": ["onClick={dismiss}"], // restores focus, then onDismiss() dismisses transient help
  "../InputModeMenu.tsx": ["open ? close() : setOpen(true)", "latest.current.onChange(value)"], // transient menu; selection is input.mode at both mounts
  "../cards/WorkflowCards.tsx": ["sendRunCommand("], // the original onRunCommand prop, before the frame wrapper
  "../cards/FlowFormCards.tsx": ["cancel.onClick()"], // card.dismiss after the keyboard focus handoff; the full submit handler is inspected
  "../cards/ApprovalAnswer.tsx": ["onAnswer(", "onClick={send}"], // the answer is a value, not a flow argument; both mounts bind onAnswer to the controller
  "../SubagentGrid.tsx": ["setFilesOpen(", "onClick={onOpen}"], // files and earlier-batch rows are local disclosures
}

const routesThroughRegistry = (context: string): boolean =>
  context.includes("runCommand") || context.includes("onRunCommand") || context.includes("runSlashCommand")

describe("launch-law parity: every affordance is a command", () => {
  const files = Object.fromEntries(surfaceFiles().map((file) => [file, read(file)]))

  test("the discovered surface set covers every component file", () => {
    // A new .tsx under src/mainview joins the scan automatically; this pins that
    // discovery actually found the known surfaces (a broken glob fails loudly).
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining([
        "../App.tsx",
        "../TranscriptMessage.tsx",
        "../ChatCards.tsx",
        "../ConnectorsSurface.tsx",
        "../SurfaceChrome.tsx"
      ])
    )
  })

  test("every action prop routes through the registry or is allowlisted", () => {
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      for (const handler of handlers(source)) {
        if (routesThroughRegistry(handler.context)) continue
        // The allowlist exempts the handler that NAMES the token, not any
        // handler that happens to sit near one: a complete one-line
        // handler matches against its own line only, so it can no longer
        // ride a neighbour's exemption through the four-line window. A
        // handler that opens a multi-line body may name its token on the
        // body's own lines.
        const opensBody = /=>\s*\{?\s*$/.test(handler.line)
        const allowance = opensBody ? handler.context : handler.line
        if (PRESENTATION_ONLY.some((token) => allowance.includes(token))) continue
        if (DELEGATED_HANDLERS[file]?.some((token) => allowance.includes(token))) continue
        violations.push(`${file}: ${handler.prop} → ${handler.context.split("\n")[0]?.trim()}`)
      }
    }
    expect(violations).toEqual([])
  })

  test("the focused guide and run-card indirections retain their bindings", () => {
    const startup = files["../StartupError.tsx"]!
    expect(startup).toContain("await nativeSwitchBackendTarget(origin, token)")
    expect(startup).toContain("switchBackendTarget(target, token, window.location.origin)")
    expect(files["../LocalAuthPanel.tsx"]).toContain("void auth.submit({")
    expect(files["../LocalAuthPanel.tsx"]).toContain("auth.close()")
    expect(files["../HelpBubble.tsx"]).toContain("onDismiss()")
    expect(files["../InputModeMenu.tsx"]).toContain('data-flow="input.mode"')
    for (const file of ["../App.tsx"]) {
      expect(files[file]).toContain('onChange={mode => controller.runCommand("input.mode", mode)}')
    }
    expect(files["../cards/WorkflowCards.tsx"]).toContain("onRunCommand: sendRunCommand")
    const form = files["../cards/FlowFormCards.tsx"]!
    expect(form).toContain('onRunCommand("form.submit", card.id)')
    expect(form).toContain('const cancel = flowAction(onRunCommand, "card.dismiss", card.id)')
    const setup = files["../cards/RepositorySetupCard.tsx"]!
    expect(setup).toContain('=> onRunCommand("setup.configure", flowArgs("setup.configure", { cardId: card.id, field, value }))')
    expect(setup).toContain('data-flow="setup.run"')
    expect(setup).toContain('=> onRunCommand("setup.view", flowArgs("setup.view", { cardId: card.id, view: next,')
    // Visibility is a host lifecycle observation, not a button or a command.
  })

  test("the expected affordances are all present (removal fails loudly too)", () => {
    // Files with no affordances at all (the composition root) are not pinned;
    // the moment one grows a handler it appears here and must be accounted for.
    const counts = Object.fromEntries(
      Object.entries(files)
        .map(([file, source]) => [file, handlers(source).length] as const)
        .filter(([, count]) => count > 0)
    )
    expect(counts).toEqual({
      // Toast dismissal is owned by ToastStack; includes dock Close and dictation controls.
      // Close, Back and Next all dispatch onboarding.act through IntroSlidesShell.
      // The optional capability reel after the last lesson: its launch pill and its Back.
      // Delegates to the shared onboarding and existing app flows; the Command-K overlay is the summoned composer with no chrome of its own.
      /*
       * The chrome Sign in button (LOCAL-APP.md: sign-in is an option in the
       * chrome, never a gate on the chat) is SessionNavigation's one handler
       * below.
       *
       * Shell bindings stay here; composer bindings are pinned independently
       * now that the hot path is its own module.
       */
      // 15 − the corner balance chip: the balance is one act away (/balance), never main-page chrome.
      // +1 (ask 5): the Flows pane's back-to-conversation close, like World's.
      // +1: the Flows pane's Triggers button, the button door of triggers.list.
      // +1 (Librarian L5): the Wiki pane's Graph button, the button door of wiki.graph.
      "../AgentMark.tsx": 1, // A persona that resolves to an agent profile is a door to the roster.
      "../App.tsx": 4, // -1: the shell has four handlers; main's five-count baseline was already stale.
      "../AppRoot.tsx": 1, // saved-store recovery Reload, with no writable command journal.
      "../ChatFilterMenu.tsx": 2,
      // Shared by the workspace and tutorial: copy, message CTA, retry, and explain.
      "../TranscriptMessage.tsx": 4,
      "../LocalAuthPanel.tsx": 4, // Includes the failed read's Retry, a FailureNotice action.
    "../RegistrationStatus.tsx": 1,
      "../StartupError.tsx": 7, // Runtime Reload, writer takeover/reload, backend chooser, credential submission, and the bootstrap Retry (a FailureNotice action).
      "../StorageRecoveryButton.tsx": 1,
    "../SubagentGrid.tsx": 7, // + the ctrl+s overview (#2190), plus earlier-batch disclosure
      "../FlowsSurface.tsx": 2,
      "../WorldSurface.tsx": 15, // The wiki spaces (#1922): the switch, New page, Graph, Edit (wiki.view), History/Rename/Delete for a page and an attachment, Attach, the local note's delete, and the empty state's New page / Create Wiki.
      "../WikiDeleteDialog.tsx": 1, // The Wiki confirmation moved to the shared shell; its command remains wiki.delete.confirm.
      "../HelpBubble.tsx": 1,
      "../InputModeMenu.tsx": 2,
      "../SessionNavigation.tsx": 1, // -1: the wordmark is a static mark; the sidebar it toggled is gone.
      "../cards/SetupChecklist.tsx": 3, // The shared step button, the shared job tile, and the dismiss; each one's flow is data, not a handler.
      "../cards/SignupCards.tsx": 6, // The signup onboarding: the GitHub door, the account submit, the repository question's repo/new-repo/skip, finish.
      "../cards/CodingVibeCard.tsx": 1,
      "../cards/RepositoryUpdateCard.tsx": 3,
      /*
       * The Library (the `plugins` surface and the guided introduction share
       * it): Install and Remove on a row, and the rail button each installed
       * plugin contributed. Every one is a delegated prop its binding site
       * runs through the registry.
       */
      "../plugins/PluginGallery.tsx": 2,
      "../plugins/PluginRail.tsx": 1,
      "../plugins/PluginsSurface.tsx": 1,
      /* 11 = 10 + the origin chip's "rev N exists · view" (lane change step 4; renders only when both seqs are known). */
      // Send and Stop, plus the prompt queue: Queue, Resume, Edit and Remove.
      "../Composer.tsx": 6,
      /*
       * 3 — the GitHub connect / disconnect pair and the empty state's own
       * import affordance (§11.6). The connected list carries no control.
       * The local-repository row and the disconnect dialog went with the
       * local backend (docs/LOCAL-BACKEND-RETIREMENT.md).
       */
      "../ConnectorsSurface.tsx": 3,
      /*
       * The card shell: the maximize backdrop, the frame back / forward /
       * fork, the maximized card's "Open in tab" (docs/LOCAL-APP.md "Cards"),
       * Restore and Maximize. Every card body lives in its family file under
       * cards/ and is pinned there.
       */
      "../ChatCards.tsx": 10, // Includes the card error boundary's Reload app, a FailureNotice action (chat.reload).
      "../ChatRunTimeline.tsx": 1,
      /* The turn's approval card: approve and deny. */
      "../cards/ApprovalCard.tsx": 2,
      /*
       * The answer box for a gate that asks a question rather than for a
       * grant: Yes, No, one per select option, and Send answer. They carry a
       * VALUE — what the person wrote — which no flow argument string can hold,
       * so they call the controller's answerApproval through the card's own
       * onAnswer prop rather than runCommand.
       */
      "../cards/ApprovalAnswer.tsx": 4,
      /* The admin grant confirm: Post the grant and Cancel, and the failed grant's Cancel beside its FailureNotice (Try again is the notice's retry action). */
      "../cards/BillingCards.tsx": 5, // Includes FailureNotice actions.
      /* The access-request queue's Approve. */
      /*
       * The run card's lane-runs acts: the two secondary tabs under the trace
       * (Steps, Transcript; Events under verbose), Check again and Stop
       * watching, launch Retry, Stop, Run again, the steer row's send, the
       * repository chooser's row and the workflow list's Run.
       */
      "../cards/WorkflowCards.tsx": 16, // Includes a failed launch's Retry, a FailureNotice action (flow.run.retry).
      "../DevtoolsPanel.tsx": 2, // + Reset conversation, admin.reset.ask's door since the rail left (#3334).
      "../SearchPalette.tsx": 6, // + Ask Smithers, the first row of an empty ⌘K
      "../SurfaceChrome.tsx": 3,
      "../ToastAction.tsx": 1,
      "../ToastStack.tsx": 1,
      /* The multi-parity domain cards: every handler routes through onRunCommand. */
      
      "../cards/IssueCards.tsx": 11, // + the detail's comment box submit (issues.comment), the thread rows, the kind chips and the saved view toggles
      "../cards/IssueThread.tsx": 6, // The chat body: composer submit and send, reaction toggles, Retry, Resolve an unknown delivery, the parent link, the state acts.
      "../cards/LandingCards.tsx": 5, // Includes the durable PR tab flow.
      "../cards/FileCards.tsx": 3,
      /* A row's Test, Edit, Remove and select; New; and the attention row's Assign, Test or Edit. */
      "../cards/ModelCallCard.tsx": 10,
      "../cards/ModelCards.tsx": 11,
      /* Mark-all-read. */
      "../cards/NotificationsCard.tsx": 1,
    "../cards/RegistrationCard.tsx": 3, // Failure Retry, completed Open, and cached Analyze again; each uses the canonical flow binding.
      "../cards/EnvCard.tsx": 3,
      /* The account card's Sign out door (auth.sign-out through onRunCommand). */
      "../cards/AccountCard.tsx": 1, // The permissions read's Retry (account.show) is a FailureNotice action.
      /* 2 = Try again + the done state's Open the workspace (lane sync). */
      "../cards/RepoImportCard.tsx": 2,
      // The tutorial's ranked chooser: one row button plus Skip.
      "../cards/RepositoryChoiceCard.tsx": 2,
      "../cards/RepositoryHomeCard.tsx": 3,
      "../cards/RepositorySetupCard.tsx": 19,
      
      "../cards/SyncCards.tsx": 5,
      /* The /theme picker: nine swatches, one shared handler through onRunCommand. */
      "../cards/ThemePickerCard.tsx": 1,
      /*
       * Lane citc: the workspace card's five facet tabs, the terminal facet's
       * Open and per-session Destroy, the snapshots' Fork-from, Template and
       * Delete, Suspend, Resume, Fork, Snapshot, the failed card's Retry, and
       * the typed delete confirm — all through onRunCommand; the draft input
       * rides the allowlist above. 15 = 13 + lane L3's ssh-host Copy (through
       * chat.copy-message) and the Egress facet's "Load older"; the Files
       * facet's rows belong to the imported FileListCardBody and are counted
       * in ITS file. 17 = 15 + lane L3b's Desktop facet: Rotate session and
       * the 409's Resume. The create affordance's three kind buttons share one
       * handler, and so does the facet strip (the Desktop tab mints through
       * box.desktop, every other tab switches through box.facet).
       * 20 = 19 + the Desktop facet's "Open a new box": the only door for a
       * box whose image predates the desktop tools, where a Retry is a door
       * onto a wall.
       */
      "../cards/WorkspaceCard.tsx": 19,
      /* The trace owns selection, views, filters and child navigation.
       * The extracted strip selects recorded sequences; summary actions reuse
       * approvals.open and runs.resume; goals reuse runs.coding.select. */
      "../cards/RunTraceCard.tsx": 15, // Includes the graph view door, the Steps view door, and a message trigger's Open (agent.session.view).
      "../cards/RunTraceSteps.tsx": 1, // Each step row selects its span.
      "../cards/RunTracePhaseStrip.tsx": 3,
      "../cards/RunTraceSummary.tsx": 5, // + Take over / Release (runs.takeover, runs.release); a guard's park adds Continue and Stop (runs.continue, flow.run.stop).
      "../cards/RunTraceGoals.tsx": 1,
      /*
       * Lane runs: the run inbox's Open per row, its All/status filter chips,
       * and the Stop-all footer (all through onRunCommand), plus the
       * approvals inbox's two decision acts (approval.approve / approval.deny
       * through the delegated onDecideApproval).
       */
      "../cards/RunsCards.tsx": 11, // + the inbox rows' run reference.
      "../cards/SearchResultsCard.tsx": 2,
      "../cards/SecretsCard.tsx": 10,
      /* Includes TODO filing, check-receipt run opening, and the failure/Wiki Retry actions. */
      "../cards/StackCard.tsx": 10, // + Land (history.land).
      /* Local Open tab, cloud session Stop, and inventory Open/Stop. */
      "../cards/AgentCards.tsx": 5, // + each profile row's Runs door (runs.list flow=<profile>).
      "../cards/AnonymousCeilingCard.tsx": 1,
      // THE FORM LAW (flow-forms.md): Cancel (card.dismiss), Submit (form.submit), and the retained PR Review (form.submit); fields commit on blur/change.
      "../cards/FlowFormCards.tsx": 3,
      // The plan card's one door, in its two states: Run once a plan exists, Plan again once one was refused.
      "../cards/FlowPlanCard.tsx": 2,
      // The run graph's bar: back to the turns, and the camera switch.
      "../cards/FlowRunGraph.tsx": 2,
      /*
       * The trigger panel (L6): the run in flight and a ledger row each open
       * their run, and a Plue registration carries Run now and Pause. The
       * trigger store's own rows carry no door, because no Control procedure
       * addresses one.
       */
      "../cards/FlowGraphTrigger.tsx": 2,
      /*
       * The node a graph has open (L5): its close, the tab strip's one
       * handler, one per dependency the node waits on, the Code tab's
       * `Open file`, the trigger drawer's own close, and a run-forest
       * node's Open and close (RunForest.ts). Every one is a `flowAction`
       * door on the card the drawer belongs to.
       */
      "../cards/FlowGraphDrawer.tsx": 7,
      /*
       * The repository welcome and its three answers (controller/onboarding.ts):
       * every door (the welcome's three, the maintainer's reads, the
       * contributor's three, the explore card's guide rows) is one shared
       * handler through onRunCommand with data-flow set.
       */
      /*
       * The repository's home pane (controller/onboarding.ts): the featured
       * flows' doors (flow.run) and Open PACKAGE.ts (files.read) are one
       * shared handler through onRunCommand with data-flow set; links are
       * anchors, not buttons.
       */
      /*
       * Lane change (ADR 0003) + lane L1 (ADR 0004, the live plue routes):
       * the change card's facet tabs, Land / Split ready / Revert / Full
       * diff, the conflict rows' Resolve, the Diff facet's two pickers, its
       * since-my-review and show-all, the file rows' one-file diff, the
       * Checks picker, Open the computer, the findings' Please fix and Not
       * useful, the review facet's show-all and thread acts, the history
       * rows' Diff to current, the diff card's re-read, and Request
       * review again after requested changes (ad40a699e) — all through
       * onRunCommand with data-flow set.
       */
      "../cards/ChangeCards.tsx": 23,
      /*
       * The plan inside a run card: Inspect review feedback and Inspect failed
       * execution (runs.trace.select), Vibe this change (flow.run), Check
       * available flows (flow.list), the predicted Change rows
       * (runs.coding.select) — all through onRunCommand with data-flow set.
       */
      "../cards/CodingPlanCard.tsx": 4,
      "../cards/CodingPocCard.tsx": 2, // Native execution inspection and existing steering form.
      /* The commits cards: a row's and a parent's commits.read, and the sha chip's chat.copy-message — all through onRunCommand. */
      "../cards/CommitCards.tsx": 3,
      "../cards/BranchesCard.tsx": 2, // a row opens that branch's commits (commits.list)
      "../cards/BurndownCard.tsx": 7, // the state filter and row (runs.burndown.*), Check again (flow.run.retry), the stop/resume confirmation (flow.run.stop, runs.signal, issue-sweep), and a group's "more" (local chrome)
      /*
       * Connection, world and browser card interactions, plus the embedded
       * wiki collaboration cards (ad438463a6): page Previous/Next and the
       * pager's onSelect, the view-mode pickers (wiki.card.view), cloud
       * Open page, and Refresh (wiki.sync) — all through onRunCommand.
       */
      "../cards/ConversationCards.tsx": 14, // The empty Wiki offers wiki.create; a cloud page offers History (wiki.history); the index card's fallback tree; the Slack row's Connect (integrations.admit).
      /* The factory card: one Open per present infra file, one shared handler through onRunCommand (files.read). */
      /*
       * The dispatcher card's Register door, the button door of
       * triggers.register (factory mock 2; sign-in is the door), and each
       * registered schedule's Run now and Pause, the button doors of
       * triggers.run and triggers.pause.
       */
      "../cards/TriggersCard.tsx": 4, // -1: a failed pause's Retry (triggers.pause) is a FailureNotice action.
      /* Librarian L5: the rail card's Open and note rows (wiki.open) and the graph card's Refresh (wiki.graph). */
      "../cards/WikiCards.tsx": 5, // + the history card's Previous/Next page (wiki.history).
      /* The wiki navigation (#1922): the space switch (wiki.space), the tree rows (wiki.select / wiki.cloud.open), the tag filter. */
      "../wiki/WikiNavigation.tsx": 4,
    })
  })

  test("delegated props are bound to commands at their call sites", () => {
    const app = files["../App.tsx"]
    const message = files["../TranscriptMessage.tsx"]
    expect(app).toContain("<TranscriptMessage")
    expect(message).toMatch(/onDownload=\{\(\) => \{\s*controller\.runCommand\(STORAGE_RECOVERY_EXPORT\)/)
    expect(message).toContain("runCommandForResult(\"chat.copy-message\"")
    expect(message).toContain("runCommand(\"chat.retry\"")
    expect(message).toMatch(/runCommand\(\s*"agent\.explain"/)
    expect(app).toContain("runCommand(\"toast.dismiss\"")
  })


  /*
   * A card's acts are bound in ONE place (cards/CardActions.ts) that the
   * transcript and a card tab both spread, so the two copies cannot drift —
   * the tab used to keep its own and had no frame controls at all. Both call
   * sites are pinned here, so deleting the shared binding fails loudly.
   */
  test("every card act is bound once, and both card surfaces use that binding", () => {
    const actions = read("../cards/CardActions.ts")
    expect(actions).toContain("\"approval.approve\"")
    expect(actions).toContain("\"approval.deny\"")
    expect(actions).toContain("runCommand(\"admin.grant.confirm\"")
    expect(actions).toContain("runCommand(\"admin.grant.cancel\"")
    expect(actions).toContain("runCommand(\"card.maximize\"")
    expect(actions).toContain("runCommand(\"card.minimize\"")
    expect(actions).toContain("runCommand(\"frame.back\"")
    expect(actions).toContain("runCommand(\"frame.forward\"")
    expect(actions).toContain("runCommand(\"frame.fork\"")
    expect(actions).toContain("runCommand(\"tab.card\"")
    expect(actions).toContain("runCommand(\"auth.sign-in\"")
    expect(actions).toContain("runCommand(\"flow.run\"")
    expect(actions).toContain("runCommand(\"flow.run.stop\"")
    expect(actions).toContain("runCommand(\"flow.run.retry\"")
    expect(actions).toContain("runCommand(\"flow.repo.choose\"")
    expect(actions).toContain("runCommand(\"wiki.edit\"")
    for (const surface of ["../App.tsx", "../tabs/CardTabBody.tsx"] as const) {
      expect(files[surface]).toContain("cardActions(controller,")
    }
  })

  /*
   * §2a/§2f — no fabricated prompt pills, ever. A pill is a command
   * BINDING; a pill carrying free text for the model is a violation unless
   * it is explicitly a composer-prefill affordance (none exist). The banned
   * literals are the slop will named verbatim; the `suggest` command was
   * the fabricated-prompt mechanism and is deleted; the suggestion set is
   * derived in App.tsx from live state (empty is correct).
   */
  test("no pill carries a prompt string for the model, and no banned generic pill exists", () => {
    const bannedLiterals = [
      "Build my work queue",
      "Build a work queue",
      "Plan my day",
      "Help me plan my day",
      "Help me connect GitHub",
      "What should I do next?"
    ]
    for (const [, source] of Object.entries(files)) {
      for (const literal of bannedLiterals) {
        expect(source).not.toContain(literal)
      }
      // The prompt-pill shape itself: a suggestion carrying prompt text.
      expect(source).not.toContain("prompt: action.prompt")
      expect(source).not.toContain("suggestion.prompt")
    }
    const registrySource = registrySources()
    expect(registrySource).not.toContain("\"suggest\"")
    // The pill row binds commands directly (§2a): the suggestion markup
    // carries the command, and the click invokes it — never send().
    const app = files["../App.tsx"] ?? ""
    expect(app).toContain("data-flow={suggestion.flow}")
    expect(app).not.toContain("data-flow=\"suggest\"")
    // No standing composer status chrome (§2g): calm is the budget.
    expect(app).not.toContain("statusText=")
  })

  /*
   * Wave 13 C-1 — the gap the live sweep found: the static gate verified
   * data-flow bindings and allowlisted presentation-only handlers, but a
   * button with NEITHER (the "Surfaces" menu trigger, whose open/close was
   * allowlisted as local state) shipped unbound. This is the live C-1 rule
   * applied to the source: a button without a data-flow binding must have
   * a static label whose words resolve to a registered command's name or
   * summary — exactly what the launch checklist checks against the DOM.
   */
  test("a button with no data-flow binding has a label that resolves to a registered command", () => {
    const registrySource = registrySources()
    const names = [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    const summaries = [...registrySource.matchAll(/\bsummary:\s*"([^"]+)"/g)].map((match) =>
      (match[1] as string).toLowerCase()
    )
    const resolves = (label: string): boolean => {
      const words = label
        .toLowerCase()
        .split(/[^a-z]+/)
        .filter((word) => word.length > 2)
      if (words.length === 0) return true
      // EVERY word must resolve: the old any-word rule passed a label on a
      // single common word ("open", "run") no matter what the rest of it
      // promised, which is exactly the fuzz a mis-bound button hides in.
      return words.every(
        (word) =>
          names.some((name) => name.includes(word) || word.includes(name)) ||
          summaries.some((summary) => summary.includes(word))
      )
    }
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      const lines = source.split("\n")
      lines.forEach((line, index) => {
        const label = /(?:aria-label|title)="([^"]+)"/.exec(line)?.[1]
        if (label === undefined) return
        // The element the label belongs to: the nearest enclosing tag start.
        let start = index
        while (start > 0 && !/^\s*<[A-Za-z]/.test(lines[start] ?? "")) start -= 1
        if (!/^\s*<(?:button|Button)\b/.test(lines[start] ?? "")) return
        const chunk = lines.slice(start, Math.min(lines.length, index + 12)).join("\n")
        if (chunk.includes("data-flow")) return
        /*
         * A component that takes its caller's binding spreads a
         * FlowBindingProps prop (`{...dismissBinding}`, HelpBubble.tsx): the
         * attributes are there at runtime, just not as a literal here. The
         * prop's type is the binding, so this is a bound button.
         */
        if (/\{\.\.\.[A-Za-z]*[Bb]inding\b/.test(chunk)) return
        if (!resolves(label)) {
          violations.push(`${file}: button "${label}" has no data-flow and resolves to no registered command`)
        }
      })
    }
    expect(violations).toEqual([])
  })

  test("binding discovery reads JSX declarations, never focus-return selectors or comments", () => {
    const source = [
      '// <button data-flow="comment.only" />',
      'const selector = `[data-flow="${flow}"]`',
      'const description = \'closeCommand="text.only"\'',
      'const view = <><button data-flow="app.first-run.dismiss" /><button data-flow={"missing.command"} />',
      '<button data-flow={`missing.template`} /><SurfaceHeader closeCommand="missing.close" />',
      '<button data-flow={action.flow} />{/* <button data-flow="comment.only" /> */}</>'
    ].join("\n")
    const bindings = literalBindings(source)
    expect(bindings).toEqual([
      { prop: "data-flow", name: "app.first-run.dismiss" },
      { prop: "data-flow", name: "missing.command" },
      { prop: "data-flow", name: "missing.template" },
      { prop: "closeCommand", name: "missing.close" }
    ])
    const declared = new Set(["app.first-run.dismiss"])
    expect(bindings.filter(({ name }) => !declared.has(name)).map(({ name }) => name)).toEqual([
      "missing.command", "missing.template", "missing.close"
    ])
  })

  test("every data-flow binding names a registered command, and the app exposes the registry manifest", () => {
    // The launch checklist reads the DOM, not the source: `.app-shell`
    // carries the live registry manifest (data-flows) and every
    // machine-legible affordance declares its command (data-flow). A
    // binding naming a command the registry does not have is a lie both
    // gates can catch here.
    const app = files["../App.tsx"]
    expect(app).toContain("const flows = controller.commands.all()")
    expect(app).toContain('data-flows={flows.map((command) => command.name).join(" ")}')
    // Registry names from the registry source itself — the same file the
    // runtime registers — so a renamed command fails this gate.
    const registrySource = registrySources()
    const declared = new Set(
      [...registrySource.matchAll(/\bname:\s*"([^"]+)"/g)].map((match) => match[1] as string)
    )
    expect(declared.size).toBeGreaterThan(0)
    const violations: Array<string> = []
    for (const [file, source] of Object.entries(files)) {
      // SurfaceHeader renders its close affordance's data-flow from
      // closeCommand, so the literal lives at the call site and is gated here.
      for (const { prop, name } of literalBindings(source)) {
        if (!declared.has(name)) {
          violations.push(`${file}: ${prop}="${name}" is not a registered command`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test("every embedded pane closes back to the conversation, not to some other surface", () => {
    // The chat-first contract: a pane's only exit is /chat. A pane wired to
    // close into another takeover would pass the registry gate above and still
    // break the contract, so the target itself is pinned.
    const panes = ["../WorldSurface.tsx", "../FlowsSurface.tsx", "../ConnectorsSurface.tsx"] as const
    for (const pane of panes) {
      const source = files[pane] ?? ""
      expect(source).toContain("closeCommand=\"chat\"")
      const targets = [...source.matchAll(/closeCommand="([^"]+)"/g)].map((match) => match[1])
      expect(targets.every((target) => target === "chat")).toBe(true)
    }
    // Every SurfaceHeader mounted anywhere declares one (a pane with an
    // unnamed close is exactly the affordance this gate exists to catch).
    for (const [file, source] of Object.entries(files)) {
      if (file === "../SurfaceChrome.tsx") continue
      const mounts = source.split("<SurfaceHeader").length - 1
      const declared = source.split("closeCommand=").length - 1
      expect(`${file}: ${mounts} SurfaceHeader / ${declared} closeCommand`).toBe(
        `${file}: ${mounts} SurfaceHeader / ${mounts} closeCommand`
      )
    }
  })

  /*
   * The two look-and-feel axes: the light/dark toggle (/dark-mode) and /theme,
   * the palette command that takes its key as an argument. The default chrome
   * has no icon rail (#3334), so the toggle's doors are slash and agent; the
   * theme picker card binds the palette command only. Both are
   * model-invocable — every listed flow is a tool call
   * (flows/invocable.test.ts) — so this test guards the binding sites and
   * the args hint, not the trigger axis.
   */
  test("the light/dark toggle and the color theme are separate commands the model can call", () => {
    const picker = files["../cards/ThemePickerCard.tsx"] ?? ""
    expect(picker).toContain("onRunCommand(\"appearance.theme\", swatch.key)")
    expect(picker).not.toContain("appearance.dark-mode")
    const registrySource = registrySources()
    // A declaration is a const literal (`const THEME = { ... }`); the slice ends
    // at the literal's close.
    const entry = (name: string): string => {
      const start = registrySource.indexOf(`name: "${name}"`)
      expect(start).toBeGreaterThan(-1)
      return registrySource.slice(start, registrySource.indexOf("\n  }\n", start))
    }
    // Listed flows are model-invocable (Will's rule; flows/invocable.test.ts
    // pins the invariant); the args hint is what makes
    // `/appearance.theme <palette>` parse as an invocation.
    expect(entry("appearance.theme")).not.toContain("userOnly")
    expect(entry("appearance.theme")).toContain("args:")
    expect(entry("appearance.dark-mode")).not.toContain("userOnly")
    // The toggle is its own flow, separate from the palette flow.
    expect(entry("appearance.dark-mode")).not.toContain("hidden")
  })

  test("the slash menu wrapper dispatches through the registry", () => {
    const composer = files["../Composer.tsx"]
    const wrapper = composer.slice(
      composer.indexOf("const runSlashCommand"),
      composer.indexOf("const onComposerKeyDown")
    )
    expect(wrapper).toContain("controller.runCommand")
  })
})
