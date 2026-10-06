/*
 * J1. Install to first merged TODO (mvp.md §5, P0). Maya's screen, from the
 * Mac installer to her first merge: setup on one card, a question answered
 * while the machine prepares, then one TODO worked to a merged PR. A fresh
 * install, so the stack starts empty and nothing else competes to merge.
 * The happy path only: a rejected key is a States entry.
 * Timeline (minutes from the install): app at 2, Source ready at 5, question
 * at 7, Machine ready at 14, Commit at 15, PR at 30, merge at 35.
 */
import type { Journey } from "../journey"
import { branch, dismissToasts, edit, present, reply, run, say, setTodo, showCard, toast, todo, type CardKind, type Entry, type Member, type Setup, type State } from "../world"
import { ALICE, BEN, INSTALL_ADDRESS, MAYA, MEMBERS, seedState } from "./seed"
import {
  ANSWER, BRANCH_NAME, CHANGE, CODING_KEY, GATEWAY_KEY, HOST_START, HOST_STARTED, INSTALLER_DONE, INSTALLER_READY, INSTALLER_TITLE, LOOPBACK,
  MAIL_CITED, MAIL_PATH, OBSIDIAN, PR, PROMPT, PROVIDER, QUESTION, REQUEST, SHELL_PROMPT, TERMINAL_TITLE, TEST_PATH, TITLE, TOKEN_PATH,
  evidence, mailFile, testFile, tokenFile
} from "./j1-data"

const TODO = "t-expire"
const BRANCH = "b-expire"
const DRAFT = "d-expire"
const CODING = `agent:${BRANCH}`
const PREPARING = "Preparing machine"
const WAKING = "Waking a machine"

type Permission = NonNullable<Member["permission"]>

/* Ben and Alice's permission on acme/api on GitHub, which their roles default from when they are added. */
const ON_GITHUB: Readonly<Record<string, Permission>> = { [BEN]: "maintain", [ALICE]: "write" }

/* mvp.md §6.15: admin or maintain makes a Maintainer, write a Member. After that, the Members card is authoritative. */
const roleFrom = (permission: Permission): Member["role"] => permission === "write" ? "member" : "maintainer"

const setup = (): State => {
  const state = seedState([MAYA])
  const { world } = state
  // A fresh install: no TODOs, no branches, nothing merged yet. No members either: signing in through the new App makes Maya the owner.
  world.stack = []
  world.todos = []
  // main is GitHub's and has no machine, so it is not a Branch here; the File card shows its chip.
  world.branches = []
  world.files = [mailFile()]
  world.mergedSinceLook = 0
  world.syncedAgo = 8
  world.members = []
  world.setup = { listen: "mac", addresses: [LOOPBACK], memory: "32 GB", github: "todo", provider: PROVIDER, obsidian: OBSIDIAN, source: "waiting", machine: "waiting" }
  state.viewers[MAYA]!.outside = { title: INSTALLER_TITLE, lines: [...INSTALLER_READY], bare: true }
  return state
}

const setupOf = (state: State): Setup => state.world.setup!

/** The Mac installer moves to its next page. */
const installer = (state: State, lines: ReadonlyArray<string>): void => {
  state.viewers[MAYA]!.outside!.lines = [...lines]
}

/* The first machine prepares in the background: the Setup card's bar, and one running notification while Maya works elsewhere. */
const preparing = (state: State, pct: number): void => {
  Object.assign(setupOf(state), { machine: "building", machinePct: pct })
  toast(state, MAYA, { tone: "running", title: PREPARING, detail: `${pct}%` })
}

/* A running notification resolves in place from the real completion, so it never spins after the work is done. */
const settle = (state: State, title: string, done: { readonly title: string; readonly detail: string }): void => {
  const screen = state.viewers[MAYA]!
  screen.transcript = screen.transcript.map((entry): Entry =>
    entry.kind === "event" && entry.title === title ? { ...entry, ...done, tone: "ok", acked: false, seq: state.seq } : entry)
}

/* Card-local view state (an open menu, a chosen scope) changes where the card is, without moving it. */
const setView = (state: State, kind: CardKind, view?: string): void => {
  for (const entry of state.viewers[MAYA]!.transcript) {
    if (entry.kind !== "card" || entry.card.kind !== kind) continue
    if (view === undefined) delete entry.card.view
    else entry.card.view = view
  }
}

/* Added by username, a person's role starts from their GitHub permission; a maintainer can change it on the card. */
const addMember = (state: State, who: string): void => {
  const permission = ON_GITHUB[who]!
  state.world.members.push({ ...MEMBERS.find(each => each.id === who)!, permission, role: roleFrom(permission), seq: state.seq })
}

const openComposer = (state: State): void => {
  dismissToasts(state, MAYA)
  state.viewers[MAYA]!.composerOpen = true
}

export const j1: Journey = {
  id: "j1",
  title: "Install to first merged TODO",
  spec: "J1",
  intro: "Maya has a Mac mini on the office network and the team's GitHub repository, acme/api. The clock starts at the install; the target is a first merge within 60 minutes.",
  viewers: [MAYA],
  setup,
  steps: [
    {
      caption: "Maya runs the Mac installer on the office Mac mini. It installs PostgreSQL 18, the machine runtime and Smithers.",
      spec: "J1.1", hold: 2600,
      act: state => installer(state, INSTALLER_DONE)
    },
    {
      caption: `In Terminal she runs ${HOST_START}. It prints a one-time setup link.`,
      spec: "J1.1", typing: { into: "outside", text: HOST_START }, hold: 3000,
      pre: state => { state.viewers[MAYA]!.outside = { title: TERMINAL_TITLE, lines: [SHELL_PROMPT], bare: true } },
      act: state => installer(state, HOST_STARTED)
    },
    {
      caption: "She opens the link on the Mac. It starts setup.",
      spec: "J1.1", hold: 2400,
      act: state => {
        delete state.viewers[MAYA]!.outside
        showCard(state, MAYA, "setup", state.world.repo)
      }
    },
    {
      caption: "Address first, because the GitHub App's sign-in returns to it. She lets the network in and types the team's address.",
      spec: "J1.2", target: '[data-mock="setup-listen"]', typing: { into: "setup-address", text: INSTALL_ADDRESS }, hold: 2800,
      pre: state => { setupOf(state).listen = "network" },
      act: state => { setupOf(state).addresses = [INSTALL_ADDRESS] }
    },
    {
      caption: "Then GitHub. Create the GitHub App runs GitHub's app-manifest flow, and she confirms once on GitHub.",
      spec: "J1.2", target: '[data-mock="setup-app"]', hold: 2400,
      act: state => { setupOf(state).appCreated = true }
    },
    {
      caption: "She signs in with GitHub through the new App. That completes the claim and makes her the owner.",
      spec: "J1.2", target: '[data-mock="setup-github"]', hold: 2400,
      act: state => {
        setupOf(state).github = "signed-in"
        state.world.members = [{ ...MEMBERS.find(each => each.id === MAYA)! }]
      }
    },
    {
      caption: "She picks acme/api and installs the App on it. It allows squash merging, and mirroring starts.",
      spec: "J1.2", target: '[data-mock="setup-repo-acme/api"]', hold: 2400,
      act: state => { Object.assign(setupOf(state), { repository: "acme/api", github: "app-installed", source: "mirroring", sourcePct: 22 }) }
    },
    {
      caption: "Model access has three roles. The fast model runs the app agent: Cerebras, through Smithers' own infrastructure, so there is no key. She signs in to Smithers with GitHub.",
      spec: "§6.5", target: '[data-mock="setup-smithers"]', hold: 2400,
      act: state => { Object.assign(setupOf(state), { smithers: "connecting", sourcePct: 38 }) }
    },
    {
      caption: "Signed in. The coding model runs the coding agent on the team's own key: she pastes an Anthropic key, or could sign in with ChatGPT.",
      spec: "§6.5", target: '[data-mock="setup-coding"]', typing: { into: "setup-coding", text: CODING_KEY }, hold: 2400,
      act: state => { Object.assign(setupOf(state), { smithers: "connected", codingKey: "validating", sourcePct: 61 }) }
    },
    {
      caption: "It saves. Then the AI Gateway key, for typed decisions. The mirror finishes: Source ready.",
      spec: "J1.3", target: '[data-mock="setup-gateway"]', typing: { into: "setup-gateway", text: GATEWAY_KEY }, hold: 2600,
      act: state => {
        Object.assign(setupOf(state), { codingKey: "saved", gatewayKey: "validating", source: "ready", sourcePct: 100 })
        preparing(state, 3)
      }
    },
    {
      caption: "The gateway key saves, and model access is done. The machine prepares in the background.",
      spec: "J1.4", hold: 2400,
      act: state => {
        setupOf(state).gatewayKey = "saved"
        preparing(state, 11)
      }
    },
    {
      caption: "Source ready means questions work. At minute 7 she asks the app agent one, and the answer cites the code within seconds.",
      spec: "J1.5", keys: "⌘ K", typing: { into: "composer", text: QUESTION }, hold: 3000,
      pre: state => { state.viewers[MAYA]!.composerOpen = true },
      act: state => {
        say(state, MAYA, QUESTION)
        reply(state, MAYA, ANSWER)
        showCard(state, MAYA, "file", MAIL_PATH, MAIL_CITED)
        preparing(state, 24)
      }
    },
    {
      caption: "Seven minutes later, Machine ready. acme/api has no Smithers files: Smithers detects Node and pnpm and installs the dependencies.",
      spec: "J1.4", hold: 2800,
      show: [{ viewer: MAYA, target: '[data-mock="card-setup"]' }],
      act: state => {
        Object.assign(setupOf(state), { machine: "ready", machinePct: 100 })
        settle(state, PREPARING, { title: "Machine ready", detail: state.world.repo })
      }
    },
    {
      caption: "She writes her first TODO in plain words. The app agent drafts it: a title and the prompt the coding agent receives.",
      spec: "J1.6", keys: "⌘ K", typing: { into: "composer", text: REQUEST }, hold: 2600,
      pre: openComposer,
      act: state => {
        say(state, MAYA, REQUEST)
        state.world.drafts.push({ id: DRAFT, title: TITLE, prompt: PROMPT, fixes: false, place: { kind: "append" } })
        showCard(state, MAYA, "draft", DRAFT)
      }
    },
    {
      caption: "Commit puts it on the empty stack as T1. It gets a branch and a machine, and the coding agent starts.",
      spec: "J1.6", target: '[data-mock="draft-commit"]', hold: 2600,
      act: state => {
        const { world } = state
        world.todos.push({ id: TODO, ref: "T1", title: TITLE, prompt: PROMPT, owner: MAYA, branch: BRANCH, state: "starting" })
        world.stack = [TODO]
        world.branches.push({ id: BRANCH, name: BRANCH_NAME, item: TODO, from: "main", machine: "waking", presence: [], activity: [], terminals: [] })
        world.files.push(tokenFile(BRANCH), testFile(BRANCH))
        world.drafts.find(each => each.id === DRAFT)!.committed = TODO
        setTodo(state, TODO, {})
        showCard(state, MAYA, "home", world.repo)
        showCard(state, MAYA, "todo", TODO)
        toast(state, MAYA, { tone: "running", title: WAKING, detail: BRANCH_NAME })
      }
    },
    {
      caption: "Seconds later the machine is awake, and the coding agent works T1 from Plan.",
      spec: "J1.6", hold: 2000,
      act: state => {
        branch(state.world, BRANCH).machine = "awake"
        present(state, BRANCH, CODING, { kind: "step", step: "plan" })
        setTodo(state, TODO, { state: "working", step: "plan" })
        dismissToasts(state, MAYA)
        settle(state, WAKING, { title: "Machine awake", detail: BRANCH_NAME })
      }
    },
    {
      caption: "Three minutes later the plan is done, and the agent edits code on the branch's machine.",
      spec: "J1.6", hold: 2200,
      act: state => {
        present(state, BRANCH, CODING, { kind: "step", step: "implement" })
        setTodo(state, TODO, { step: "implement", elapsed: "3m" })
      }
    },
    {
      caption: "Six minutes later, Verify runs the repository's typecheck, tests and lint on the machine.",
      spec: "J1.6", hold: 2000,
      act: state => {
        for (const line of CHANGE) edit(state, line.path, line.n, line.text, CODING)
        present(state, BRANCH, CODING, { kind: "step", step: "verify" })
        setTodo(state, TODO, { step: "verify", elapsed: "9m" })
      }
    },
    {
      caption: "Four minutes later the agent reviews its own change.",
      spec: "J1.6", hold: 1800,
      act: state => {
        present(state, BRANCH, CODING, { kind: "step", step: "review" })
        setTodo(state, TODO, { step: "review", elapsed: "13m" })
      }
    },
    {
      caption: `At minute 30, T1's PR #${PR} opens on GitHub with its evidence, and the idle machine sleeps. Merge waits for GitHub's own checks.`,
      spec: "J1.6", hold: 2800,
      act: state => {
        const item = todo(state.world, TODO)
        delete item.step
        delete item.elapsed
        setTodo(state, TODO, { state: "in-review", pr: PR, evidence: evidence(3), mergeBlock: "2 checks running on GitHub" })
        branch(state.world, BRANCH).machine = "asleep"
        branch(state.world, BRANCH).presence = []
        toast(state, MAYA, { tone: "ok", title: `PR #${PR} is ready for review` })
      }
    },
    {
      caption: "She reads the diff in the app: three lines in two files. GitHub's checks pass, 5 of 5, and Merge turns on.",
      spec: "J1.7", target: `[data-mock="diff-${TODO}"]`, hold: 2800,
      pre: state => dismissToasts(state, MAYA),
      act: state => {
        delete todo(state.world, TODO).mergeBlock
        setTodo(state, TODO, { evidence: evidence(5) })
        showCard(state, MAYA, "diff", TOKEN_PATH)
        showCard(state, MAYA, "diff", TEST_PATH)
      }
    },
    {
      caption: "Nothing else is on the stack, so T1 is next to merge. She merges at minute 35, inside the 60-minute target.",
      spec: "J1.7", target: `[data-mock="merge-${TODO}"]`, hold: 2800,
      act: state => {
        setTodo(state, TODO, { state: "merged" })
        branch(state.world, BRANCH).machine = "closed"
        run(state, { id: "learn", title: `Learning from #${PR}`, state: "running" })
        toast(state, MAYA, { tone: "ok", title: `Merged #${PR}` })
      }
    },
    {
      caption: "A learning run follows and leaves 2 lessons in the wiki for the next TODO's plan.",
      spec: "§4.1", hold: 2600,
      act: state => {
        dismissToasts(state, MAYA)
        setTodo(state, TODO, { lessons: 2 })
        run(state, { id: "learn", title: `Learning from #${PR}`, state: "done", detail: "2 lessons" })
      }
    },
    {
      caption: "Now her team: /members. People sign in with GitHub, so there are no invitations; she adds them by username.",
      spec: "J1.8", keys: "⌘ K", typing: { into: "composer", text: "/members" }, hold: 2200,
      pre: openComposer,
      act: state => {
        state.viewers[MAYA]!.composerOpen = false
        showCard(state, MAYA, "members", state.world.repo)
      }
    },
    {
      caption: "She adds Ben. Roles follow GitHub: admin or maintain makes a Maintainer, write a Member.",
      spec: "§6.15", target: '[data-mock="member-login"]', typing: { into: "member-login", text: "benortiz" }, hold: 2600,
      act: state => addMember(state, BEN)
    },
    {
      caption: "Then Alice, who can write: a Member. Each opens the team's address and signs in with GitHub.",
      spec: "J1.8", target: '[data-mock="member-login"]', typing: { into: "member-login", text: "alicepark" }, hold: 3000,
      act: state => addMember(state, ALICE)
    },
    {
      caption: "/secrets: two secrets the tests need. Values are write-only.",
      spec: "J1.8", keys: "⌘ K", typing: { into: "composer", text: "/secrets" }, hold: 1800,
      pre: openComposer,
      act: state => {
        state.viewers[MAYA]!.composerOpen = false
        showCard(state, MAYA, "secrets", state.world.repo)
      }
    },
    {
      caption: "STRIPE_TEST_KEY reaches every branch's machine.",
      spec: "§6.15", target: '[data-mock="secret-name"]', typing: [{ into: "secret-name", text: "STRIPE_TEST_KEY" }, { into: "secret-value", text: "sk_test_51Nq8x" }], hold: 1800,
      act: state => { state.world.secrets.push({ name: "STRIPE_TEST_KEY", scope: "all branches" }) }
    },
    {
      caption: "SENTRY_DSN reaches only main, like a GitHub environment limited to the default branch.",
      spec: "§6.15", target: '[data-mock="secret-scope"]', typing: [{ into: "secret-name", text: "SENTRY_DSN" }, { into: "secret-value", text: "https://4f1c@o2.ingest.sentry.io/7" }], hold: 2400,
      pre: state => setView(state, "secrets", "scope:main"),
      act: state => {
        state.world.secrets.push({ name: "SENTRY_DSN", scope: "main only" })
        setView(state, "secrets")
      }
    },
    {
      caption: "/settings keeps what setup asked, plus capacity and the Obsidian folder the wiki syncs with. She copies the line that connects a laptop agent, such as Claude Code.",
      spec: "§6.1", keys: "⌘ K", typing: { into: "composer", text: "/settings" }, hold: 3600,
      pre: openComposer,
      act: state => {
        state.viewers[MAYA]!.composerOpen = false
        showCard(state, MAYA, "settings", state.world.repo, "copied")
      }
    }
  ]
}
