import { journey } from "./define.mjs"
export default journey("J6", "Bring your own agent", [
  ["terminal", "C-J6-01", "Ben opens a branch terminal already signed in to Smithers, with the generated skill. Live Claude Code reads wiki, answers Needs you and places a follow-up TODO; actions show Ben via Claude Code. Teammates watch without using his login; verify token permissions and revocation without retaining token values."],
  ["laptop", "C-J6-02", "Ben signs in from his laptop to the configured install origin; a delegated credential can read and place work but cannot merge. A merge request opens a person Confirm card and only a browser session can confirm."]
])
