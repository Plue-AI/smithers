/*
 * J10. GitHub sync (mvp.md §6.3, M-22, P0). Maya's Smithers on the left, the
 * TODO's pull request as GitHub shows it on the right. GitHub keeps main,
 * issues, PRs, reviews and checks; Smithers keeps TODOs, stack order, live
 * branches, runs and the wiki. Every PR is based on main and lists the
 * earlier stack items it includes. Each new revision reruns the checks.
 */
import { cite, type Journey } from "../journey"
import { activity, branch, checksPassed, dismissToasts, edit, revise, run, setTodo, showCard, stackOp, toast, todo, type State } from "../world"
import { ALICE, BEN, MAYA, RETRY_FILE, seedState } from "./seed"

const AGENT = "agent:b-retry"
const PR = 214

const pr = (state: State) => state.world.github.find(each => each.number === PR)!

const setup = (): State => {
  const state = seedState([MAYA])
  const { world } = state
  world.todos = world.todos.filter(each => each.id === "t-stripe" || each.id === "t-retry" || each.id === "t-checkout")
  world.stack = ["t-stripe", "t-retry", "t-checkout"]
  world.branches = world.branches.filter(each => each.id !== "b-log")
  Object.assign(todo(world, "t-retry"), {
    state: "in-review", pr: PR, question: undefined, step: undefined, elapsed: undefined,
    evidence: {
      rev: "3f2a1c9", files: 2, added: 26, removed: 9,
      checks: [{ name: "typecheck", state: "passed", took: "12s" }, { name: "test", state: "passed", took: "51s" }],
      github: { passed: 5, total: 5 }, review: "No blocking issues."
    }
  })
  branch(world, "b-retry").presence = [{ who: ALICE, where: { kind: "file", path: RETRY_FILE, line: 10 } }]
  edit(state, RETRY_FILE, 8, "    await sleep(backoff(attempt))", AGENT)
  edit(state, RETRY_FILE, 14, "  await sleep(backoff(1))", AGENT)
  world.github.push({
    number: PR, todo: "t-retry", title: "Retry failed webhooks with backoff", base: "main", head: "smithers/retry-webhooks",
    state: "open", requestedBy: BEN,
    body: [
      "Failed webhook deliveries retry up to 5 times with backoff, then mark the event failed. Fixes #212.",
      "Checks on the machine: typecheck ✓ · test ✓ · Review: no blocking issues.",
      "Includes #88 (Upgrade the Stripe SDK to v17), which merges first."
    ],
    commits: [{ by: "smithers-app", text: "fix(webhooks): retry failed deliveries with backoff", sha: "3f2a1c9" }],
    thread: [], approvals: [], required: 1, draftAfter: "T8"
  })
  showCard(state, MAYA, "home", "acme/api")
  return state
}

export const j10: Journey = {
  id: "j10",
  title: "GitHub sync",
  spec: "J10",
  intro: "Maya's Smithers on the left; the same pull request on GitHub on the right. Changes made on either side reach the other.",
  viewers: [MAYA, "github"],
  githubPr: PR,
  setup,
  steps: cite(["J10.1", "J10.2", "J10.2", "J10.2", "J10.3", "J10.3", "J10.4", "§4.2", "§4.2", "J10.5", "§6.3", "§6.3", "J10.5", "J10.6", "J10.6"], [
    {
      caption: "The TODO's PR lives on GitHub: opened by the Smithers app for Ben, based on main. It's a draft until T8 (#88), which it includes, merges first.",
      viewer: MAYA, target: '[data-mock="open-t-retry"]', hold: 3400,
      act: state => { showCard(state, MAYA, "todo", "t-retry") }
    },
    {
      caption: "Alice reviews on GitHub and comments on line 14.",
      viewer: "github", target: '[data-mock="gh-comment"]', typing: { into: "gh-comment", text: "Log the attempt number here too." }, hold: 1400,
      act: state => { pr(state).thread.push({ who: ALICE, text: "Log the attempt number here too.", line: 14, seq: state.seq }) }
    },
    {
      caption: "Within a minute it reaches Smithers as Alice's steer, marked as from GitHub. The TODO goes back to Working.",
      hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-branch"]' }],
      act: state => {
        activity(state, "b-retry", ALICE, "steer", "Log the attempt number here too. (line 14)", undefined, true)
        setTodo(state, "t-retry", { state: "working", step: "implement" })
        showCard(state, MAYA, "branch", "b-retry")
      }
    },
    {
      caption: "The agent answers the way an engineer would: with a commit. It lands on both sides, and the new revision's checks start over.",
      hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-todo"]' }],
      act: state => {
        edit(state, RETRY_FILE, 14, "  await sleep(backoff(1)); log.retry(event.id, 1)", AGENT)
        activity(state, "b-retry", AGENT, "edit", "Logged the attempt number in redeliver() · 8b1e204", "ok")
        pr(state).commits.push({ by: "smithers-app", text: "log the attempt number on redelivery", sha: "8b1e204" })
        setTodo(state, "t-retry", { state: "in-review" })
        revise(state, "t-retry", "8b1e204")
      }
    },
    {
      caption: "Alice pushes a commit from her laptop to the PR's branch. Smithers never overwrites a person's commit: it holds the agent's next push, and it is Needs you.",
      hold: 3200,
      show: [{ viewer: MAYA, target: '[data-mock="card-todo"]' }],
      act: state => {
        pr(state).commits.push({ by: "alicepark", text: "test: cover giving up after the fifth attempt", sha: "c41d9e2" })
        setTodo(state, "t-retry", { state: "needs-you", needs: "foreign_push", pushedBy: ALICE, step: "review",
          question: { text: "Alice pushed to smithers/retry-webhooks on GitHub." } })
        toast(state, MAYA, { tone: "attention", title: "Alice pushed to smithers/retry-webhooks", detail: "Not in the live working copy", action: "Review" })
      }
    },
    {
      caption: "Ben brings it in from his own screen. The branch rebases onto her commit at a checkpoint, and checks rerun on that revision.",
      hold: 3200,
      show: [{ viewer: MAYA, target: '[data-mock="card-branch"]' }],
      act: state => {
        dismissToasts(state, MAYA)
        stackOp(state, "b-retry", "Brought in Alice's commit c41d9e2", BEN)
        setTodo(state, "t-retry", { state: "in-review", needs: undefined, pushedBy: undefined, question: undefined, step: undefined })
        revise(state, "t-retry", "c41d9e2")
      }
    },
    {
      caption: "Someone merges an unrelated PR on GitHub. main moves. The branch with people on it shows Rebase pending; branches with nobody present rebase on their own.",
      hold: 3200,
      show: [{ viewer: MAYA, target: '[data-mock="card-branch"]' }],
      act: state => {
        state.world.mergedSinceLook += 1
        state.world.mainHead = { text: "#216 Fix the docs link · just now", seq: state.seq }
        branch(state.world, "b-retry").rebasePending = "main"
        stackOp(state, "b-checkout", "Rebased onto T9")
        toast(state, MAYA, { tone: "ok", title: "main moved", detail: "#216 merged on GitHub" })
      }
    },
    {
      caption: "Maya presses Rebase now. Everyone on the branch sees it rebase. The revision changed, so every check reruns on it, and nothing stays green from before.",
      viewer: MAYA, target: '[data-mock="rebase-b-retry"]', hold: 2600,
      show: [{ viewer: MAYA, target: '[data-mock="evidence-t-retry"]' }],
      act: state => {
        branch(state.world, "b-retry").rebasePending = undefined
        stackOp(state, "b-retry", "Rebased onto T8 · checks rerun on 5e7d2b0", MAYA)
        revise(state, "t-retry", "5e7d2b0")
        dismissToasts(state, MAYA)
      }
    },
    {
      caption: "Checks pass on 5e7d2b0. Alice is done and leaves the branch.",
      hold: 2400,
      act: state => {
        checksPassed(state, "t-retry", { typecheck: "12s", test: "49s" })
        branch(state.world, "b-retry").presence = []
      }
    },
    {
      caption: "Maya merges #88 on GitHub instead of in Smithers. Its TODO turns Merged. #214 rebases on its own, stops listing #88 and is ready for review.",
      hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-home"]' }],
      act: state => {
        setTodo(state, "t-stripe", { state: "merged" })
        branch(state.world, "b-stripe").machine = "closed"
        pr(state).body.splice(2, 1)
        pr(state).draftAfter = undefined
        stackOp(state, "b-retry", "Rebased onto main · checks rerun on a1f9e33")
        revise(state, "t-retry", "a1f9e33")
        setTodo(state, "t-retry", { mergeBlock: "1 approving review required on GitHub" })
      }
    },
    {
      caption: "Checks pass on a1f9e33. #214 is next, but GitHub requires an approving review, and Merge says so in GitHub's own words.",
      viewer: MAYA, target: '[data-mock="evidence-t-retry"]', hover: true, hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="evidence-t-retry"]' }],
      act: state => { checksPassed(state, "t-retry", { typecheck: "11s", test: "47s" }) }
    },
    {
      caption: "Ben approves on GitHub. In Smithers the same button turns into Merge.",
      hold: 2600,
      act: state => {
        pr(state).approvals.push(BEN)
        pr(state).thread.push({ who: BEN, text: "Approved these changes.", seq: state.seq })
        setTodo(state, "t-retry", { mergeBlock: undefined, approvedRev: "a1f9e33" })
      }
    },
    {
      caption: "Maya merges on GitHub. The TODO turns Merged, #212 closes with a link, and learning starts.",
      viewer: "github", target: '[data-mock="gh-merge"]', hold: 3000,
      show: [{ viewer: MAYA, target: '[data-mock="card-todo"]' }],
      act: state => {
        pr(state).state = "merged"
        pr(state).mergedBy = MAYA
        setTodo(state, "t-retry", { state: "merged" })
        branch(state.world, "b-retry").machine = "closed"
        branch(state.world, "b-retry").presence = []
        run(state, { id: "learn-214", title: "Learning from #214", state: "running" })
      }
    },
    {
      caption: "If the network drops, the main row says how stale it is, in gold, with Retry.",
      hold: 2800,
      show: [{ viewer: MAYA, target: '[data-mock="card-home"]' }],
      act: state => { state.world.syncedAgo = 360 }
    },
    {
      caption: "Retry syncs again. Nothing on either side was lost.",
      viewer: MAYA, target: '[data-mock="card-home"] .mvp-sync button', hold: 2600,
      act: state => {
        state.world.syncedAgo = 3
        setTodo(state, "t-retry", { lessons: 1 })
        run(state, { id: "learn-214", title: "Learning from #214", state: "done", detail: "1 lesson" })
      }
    }
  ])
}
