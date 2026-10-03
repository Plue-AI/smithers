import { journey } from "./define.mjs"
export default journey("J11", "Look under the hood", [
  ["inspect", "C-J11-01", "Inspect a merged TODO's real run: graph, each step's state/I/O/transcript, retries, answered waits with since, tokens/time/cost and recovery timeline. Open flow Source, add a step on scratch and Run a test input; record the new graph live."],
  ["model", "C-J11-03", "As owner, switch a factory agent to another live model on the Agent card. The next model call in an existing run uses it immediately with the same flow digest. Instructions still change through a TODO; record old/new model-call receipts."],
  ["source-run", "C-J11-02", "Open the proposing TODO's flow Source in the File card on its branch, edit on a scratch branch, view its typed Plan and Run a test input as a draft version: the new step appears live within 1 s, and the draft run cannot propose or write GitHub."],
  ["thrashing", "C-J11-04", "Drive one attempt to fail the same check three times with no edit in between: the TODO card and the Inspect phase flag thrashing deterministically; one edit clears it."]
])
