# Machine placement: this Mac and other computers

Design for #3706 (Will, 2026-10-04: sandboxes on this machine and on remote boxes such as Smithers Cloud, feature flagged). The product contract is #3706's "Product position", which lands as M-40 in [`../product/mvp.md`](../product/mvp.md). The engineering contract is 8a's. This page answers three questions:

1. Where does the owner add a computer?
2. Where does a person see which computer a branch's machine runs on?
3. Where does a person choose the computer for one TODO?

## The flag

`remote_sandboxes` is set in the install's config file. It has no UI.

- **Off (the default):** nothing on this page renders, unless branches still live on another computer.
  - Settings shows today's "This Mac" capacity row, and every card reads as it does now.
- **Turned off while branches live elsewhere:** Add computer and the Runs on control disappear. Each computer that still holds branches keeps its row, reading "beaver · 2 branches · remove to finish", and those branches keep their suffix. Nothing hides where work runs.

## Words

| Word | Meaning | Copy |
| --- | --- | --- |
| **Machine** | A branch's isolated place to run (unchanged). | "Machine awake", "Waiting for a machine · #2" |
| **Computer** | Where machines run: This Mac, a Linux computer such as `beaver`, or Smithers Cloud. New word. | "This Mac", "beaver", "Smithers Cloud" |
| **Auto** | Smithers picks the computer with free capacity when the branch first wakes. | "Runs on: Auto" |

"Computer" was chosen over three alternatives:
- "machine" is taken.
- "host" already means five things in mvp.md.
- "place" is stack placement, and the Runs on row sits directly under Place.

A computer is always called by its name. `copy.mjs` keeps its bans, so no card copy says microVM, VM, sandbox or box, and `copy.mjs` gains no new ban.

## 1. Settings: Computers (owner only)

Settings is the owner's card (mvp.md Appendix A `/settings`). When the flag is on, its "This Mac" capacity row becomes a **Computers** list. Members never see this list; they see computers only as suffixes (section 2).

```
 Computers                                    9 machines
 ─────────────────────────────────────────────────────────
 ● This Mac        macOS              3 machines   2 in use   ⋯
 ○ beaver          Linux              1 machine    0 in use   ⋯
 ● Smithers Cloud  Smithers Cloud     2 machines   1 in use   ⋯
 ● mini-2          Unreachable · connection refused   Retry   ⋯
                                                 [ Add computer ]
```

- Each row has a dot, the name, a kind chip ("macOS", "Linux", "Smithers Cloud"), capacity and in-use count.
  - **Dot:** teal when machines are in use; neutral when online and idle; quiet when paused; ember when unreachable; gold when signed out.
  - **Capacity:** comes from each computer's own memory and disk (M-06 per computer). The title count sums online computers only; paused, unreachable and signed-out capacity isn't counted. It is the same number Home shows.
- **This Mac** is always first. It can be paused (all work goes elsewhere) but never removed. It keeps today's "No machine fits" line, with its limiting term and fix link.
- **The ⋯ menu:**
  - **Machines limit:** today's stepper, per computer.
  - **Pause / Resume:** paused means no new machines; awake ones keep running.
  - **Remove.**
- **Remove** is an inline two-step in the row: "Remove beaver?" · Remove · Cancel, the same pattern as Members.
  - While branches live on the computer, the row shows the reason as a link instead: "2 branches on beaver ↗" opens the branch list.
  - An **unreachable** computer can be removed anyway. The two-step reads "Remove beaver? 2 branches close", and each branch's activity records "Closed · beaver removed by Will".
  - Queued TODOs pinned to a removed computer move to Auto, and the two-step names them: "3 queued TODOs move to Auto".
- **Unreachable:** the row shows the provider's reason, with **Retry**. **Signed out** (Cloud): the row reads "Signed out · Sign in".

### Add computer

**Add computer** opens a form in the card. The computer joins by running the Smithers worker, which registers itself with the install (8a §8.13.0; Will, 2026-10-04: reuse the Smithers Cloud controller and worker). It uses Setup's step pattern: each step shows when the step before it is done.

```
 Add computer
 Kind      ( Linux computer | Smithers Cloud )
 Name      beaver
 Run on beaver:
   curl -fsSL https://maya-mini.tail1234.ts.net/join/7Kq2… | sh   [ Copy ]
 ─────────────────────────────────────────────
 ◐ Waiting for beaver…
 ✓ Joined     ✓ Linux x86_64     ✕ Runtime     ○ Machine image
   Virtualization is off · turn on VT-x in firmware ↗   [ Retry ]
 Capacity  1 machine (15 GB, 4 cores)
                                         [ Add beaver ]
```

- **Linux computer:**
  - Naming it creates a one-time join line, with Copy (copyText). The line expires after 1 hour, and **New line** replaces it.
  - The owner runs it on the computer. Until the worker checks in, the form reads "Waiting for beaver…". No address, key or port is typed into Smithers.
  - Once the worker joins, the steps run: **Joined**, then the OS and architecture, then **Runtime** (the computer can run isolated machines), then **Machine image**, the same progress as Setup step 6.
  - Runtime fails with its fix, as toolchain detection does. On `beaver` today that line is "Virtualization is off · turn on VT-x in firmware ↗" (no `/dev/kvm`, #3706 13:20 facts). Retry reruns the probe after a person fixes it at the keyboard.
- **Smithers Cloud:** shows Sign in, then a Machines limit stepper.
- Each step fails in place with its reason and Retry. The primary button stays disabled until the image is ready, and names the computer: "Add beaver".
- Capacity is the install's rule applied to that computer (§8.2.1). `beaver` gets 1.
- Open with 8a until §8.13 is rewritten: the join line's exact command, and whether the computer must reach the install's address (§1.4 keeps it on loopback by default). If it must, the form shows that requirement as a blocked step with its fix link, the same way Setup shows address problems.

## 2. Seeing where a machine runs

The computer appears wherever the machine state already shows, as one suffix, `· beaver`, never as a new row.

| Card | Today | With 2+ computers |
| --- | --- | --- |
| Branch header | `● Machine awake` | `● Machine awake · beaver` |
| TODO card, branch line | `retry-webhooks · awake` | `retry-webhooks · awake · beaver` |
| Home, machines strip | `3 / 9 machines` with slot avatars | Slots grouped by computer, each group after a muted name divider |
| Queued TODO | `Waiting for a machine · #2` | Pinned: `Waiting for a machine · beaver · #1`. Auto: the position on the computer it will take |
| Awake, computer unreachable | none | Branch: ember `Machine unreachable · beaver` with Retry. TODO: Failed, `failure.class: computer_unreachable`, with Retry |
| Asleep, computer unreachable | none | Branch: `Asleep · beaver unreachable`. File card: `Unavailable · beaver unreachable` in place of content |
| Cloud signed out | none | Read as unreachable, with the reason `Smithers Cloud signed out` |
| Waking on a paused computer | none | Gold `beaver paused`. The owner also gets **Resume** |

Further rules:
- **When the suffix appears:** only once a second computer exists. With only This Mac registered, `· This Mac` never repeats on every card.
- **How it looks:** plain text in the muted machine line, never a chip. For the owner it links to the computer's Settings row, through a supplied gesture; members see plain text.
- **Isolation:** shown nowhere on the cards. #3706 point 5 says the card shows where a branch runs; how a computer isolates machines is checked once, at Add (the Runtime step).
- **Same on every computer:** SSH, terminals and co-editing. The SSH line stays the install's own address (`ssh -p 2222 retry-webhooks@<install host>`), and the install reaches the computer.
- **Forks:** they run where their origin branch runs. A fork from `main` is Auto.

## 3. Choosing the computer for one TODO

The override lives where a TODO is shaped: the **Draft** card's place row, and **Edit** while the TODO is Queued.

```
 Place      ( Append | Before T8 | Amend T5 )
 Runs on    ( Auto | This Mac | beaver | Smithers Cloud )
```

- **The control:** a segmented control under Place. The default is **Auto**, which isn't written into the TODO.
- **When it shows:** only when the flag is on and two or more computers exist. A paused, unreachable or signed-out computer shows disabled, with its state as the reason.
- **On the TODO card:** while Queued, a pinned choice shows as one muted line under the title, "Runs on beaver". Auto shows nothing. After wake, the line goes and the branch line's suffix carries the same fact.
- **When it applies:** at the branch's first wake. A sleeping branch wakes on the same computer. Moving a branch between computers is not designed.
- **A pinned TODO:** waits for its computer even when another has room. People still go first on that computer (M-13). If its computer is paused, the Queued card reads `Waiting for a machine · beaver paused`.
- **The app agent** sets it ("run T12 on beaver") through the same Draft field, as it sets Place.
- **Queues:** one queue per computer. An Auto TODO shows its position on the computer it would take now, recomputed until it wakes.

## Props (proposed, for 8a's engineering spec)

These are additions only. Every one is optional, so the flag-off props are unchanged.

```ts
type ComputerStep = Omit<SetupStep, "id"> & { id: "joined" | "os" | "runtime" | "image" }
type Computer = {
  id: string; name: string                                   // "This Mac", "beaver"
  kind: "this_mac" | "linux" | "cloud"
  label: string                                              // the chip: "macOS", "Linux", "Smithers Cloud"
  capacity: number; in_use: number; limit?: number           // limit: the per-computer Machines stepper
  state: "online" | "paused" | "unreachable" | "signed_out"
  error?: { class: string; message: string }                 // unreachable: the provider's reason
  branches: number                                           // awake + asleep; Remove shows the reason link
  queued_pinned: number                                      // named in the Remove two-step
}
// SettingsModel: computers?: Computer[]            present when the flag is on, or any non-This-Mac computer holds branches
//                adding?: { kind: "linux" | "cloud"; steps: ComputerStep[]; join_line?: string; join_expires_at?: string; capacity?: number }
// MachineState (all variants): computer?: string   the name; present only when 2+ computers exist
//   "failed" with error.class "unreachable" | "signed_out" renders the section 2 copy
// DraftModel:    runs_on?: { value: "auto" | string; options: { id: string; name: string; disabled?: { reason: string } }[] }
//                gestures.set field "runs_on", value "auto" or a computer id
// TodoModel:     runs_on?: string                  a pinned computer's name; rendered while Queued only
//                queue.computer?: string; queue.paused?: boolean
// HomeModel:     machines.slots[].computer?: string
// gestures.computer { id } on Branch, TODO and Home: owner only; absent means plain text
// Actions: computer.add, computer.join_line, computer.pause, computer.resume, computer.remove, computer.retry,
//          computer.limit. All are Owner, person only (agents: never), so 98 adds them to Appendix B.2 and B.4.
```

## What M-40 must change in mvp.md (98)

This page lands as proposed and becomes the design when 98's M-40 commit lands. That commit carries:

- A §3 vocabulary row for **Computer**.
- M-37's last sentence ("Remote machines for the install stay deferred"): superseded.
- M-10 scope: the install runs on an Apple Silicon Mac; computers may be Linux or Smithers Cloud.
- M-06: capacity is the sum over online computers.
- The §1.4 "Linux-server owners: Defer" row: the install stays on a Mac; computers are not deferred behind the flag.
- Appendix B rows for the seven `computer.*` actions.

## Falsifier

This design fails if the owner can't add `beaver` from Settings and then see `Machine awake · beaver` on a branch card, within one session, with no step except running the join line on `beaver`.
