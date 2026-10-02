import { journey } from "./define.mjs"
export default journey("J1", "Install to first merged TODO", [
  ["soak", "C-REL-05", "Before recordings, verify the same release's 24 h credential soak on two machines: Claude Code, Codex and gh every 10 min, B sleep/wake every 4 h, credential_changed delivery before the next call. Retain call, wake and credential event logs without tokens.", { kind: "evidence", phase: "prerequisite" }],
  ["install", "C-J1-01", [
    "On the erased reference Mac, begin host recording and DNS/nettop connection log. Record macOS build, host profile and NTP offset. T0 is the first install keystroke.",
    "Follow only the released quickstart: brew install smithersai/tap/smithers; smthrs host start. Record release version/commit, timings, readyz and both printed URLs. Exactly one sudo prompt at host start.",
    "Open setup in Safari and Chrome; verify steps 0–6 and detected limits. From B test LAN IP and .local are refused until Address changes. Repeat host start; verify one daemon/process, same token and no second sudo.",
    "Classify every outbound hostname; no Smithers-operated service. Record brew info, host status, launchctl print and connection classification."
  ], { checks: ["C-REL-02"], hostRecording: true }],
  ["setup", "C-J1-02", [
    "Complete Address, GitHub App manifest and installation, owner sign-in, squash prerequisites and three live model roles. Pause for the live-model/repository guard before the first model call.",
    "After Source ready and while Machine ready is pending, ask JOURNEY.md's code question and receive the answer with file cards. Record timestamps and real model receipts, then finish Machine ready.",
    "Test invalid key, setup-token replay, reload and restart. Record install events before each rendered completion; Source ready precedes Machine ready."
  ], { checks: ["C-J1-03"] }],
  ["activation", "C-J1-04", "Without assistance, append JOURNEY.md's first TODO; record Queued/Starting/Working/In review, evidence and PR; review and Merge in the app. Record GitHub merged_at, reviewed head, session approval, squash commit, T0/T1 and both clock offsets; corrected elapsed time must be ≤60 min."],
  ["members", "C-J1-05", "Add Ben as Maintainer and Alice as Member; exercise needs-access-on-GitHub failure and their distinct sign-ins from B at the configured public origin. Set the two required secrets."],
  ["machine", "C-J1-06", "Verify the canary had no .smithers files, toolchain detection found npm test, dependencies prepared in the background and the first machine ran a real check. Retain the detection and machine-ready receipts."]
])
