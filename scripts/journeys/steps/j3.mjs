import { journey } from "./define.mjs"
export default journey("J3", "Join a branch", [
  ["presence", "C-J3-01", "Join a Needs you branch as Ben and Alice; show their current File/Terminal/run locations and owner via SSH attribution."],
  ["terminal", "C-J3-02", "Ben opens his own terminal and runs the failing test; Alice watches read-only and her keystrokes are dropped. Record user identity and both views."],
  ["format", "C-J3-03", "Owner formats 12 files through SSH: one attributed activity entry opens the diff, file cards update in place and the agent re-reads. Record the active outside session set."],
  ["coedit", "C-J3-04", "Run the live non-overlapping and same-line typing cases with Ben and Alice, synchronized from one monotonic clock. Capture 400 character arrival timings, text/disk digests, saved acknowledgments, authors, restart retention, reopen retention, and read-only large/binary cards."],
  ["outside", "C-J3-04", "With no agent session active and owner the only outside session, Ben and Alice type in retry.ts. outside-save.mjs makes an untouched-line save then a stale typed-line save. Verify owner via SSH, both acknowledged saves survive, document wins overlapping disk text, outside snapshot is recoverable and Changed outside Smithers · Compare displays it.", { operation: "outside-save" }],
  ["steer", "C-J3-05", "Steer with author attribution on the same working copy; while a question is pending, Steer does not settle it. Answer use the existing retry helper and verify the answering avatar and continuing agent."],
  ["ssh", "C-J3-06", "Use the member's GitHub SSH keys and printed SSH line; edit through VS Code Remote and exercise port forwarding. Record attributed saves and rejected unauthorized keys."],
  ["rename", "C-J3-08", "Delete then rename a file while its card is open; verify paused editing, Restore and Follow with text retained."],
  ["checkout", "C-J3-09", "On the branch machine, the owner deliberately checks out main. Verify Needs you and both Return to Tn and Keep for now paths; no silent loss of the captured change."],
  ["agent-terminal", "C-J3-10", "Watch coding-agent commands in the Terminal card with live output, timestamps and attribution; retain executed command receipts."]
])
