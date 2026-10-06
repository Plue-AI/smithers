/*
 * Install setup and owner settings (mvp.md J1, §6.1, §6.3, §6.5, §6.11, §6.15).
 *
 * Setup is one card: four asks, then two progress steps. The address comes
 * first, because the GitHub App's sign-in callback is registered to it. Then
 * GitHub: create the App, then sign in through it, which completes the claim
 * and makes the person the owner (opening the setup link doesn't). Then the
 * repository, which installs the App on it, and model access.
 * Questions work at Source ready; TODOs need Machine ready. A pending step
 * never claims success, a credential is masked from its first character,
 * and every key validates before it is saved.
 *
 * Model access has three roles (§6.5; Will, 2026-10-03). The fast model is
 * Cerebras through Smithers' own infrastructure: a Smithers sign-in, no key.
 * The coding model (a key, or a ChatGPT sign-in in its place) and the AI
 * Gateway are the team's own keys. Later, without the Smithers sign-in, the
 * app agent uses the coding model.
 *
 * The one prerequisite check is engineering's `squash`, shown on the chosen
 * repository; a failure links to the fix.
 *
 * Settings is the owner's. This Mac comes first: who can reach the install
 * and at which addresses (mvp.md §6.1). A change that fails to apply keeps
 * the old address in effect, with the reason and Retry. Each other row is a
 * door to what it names, and the capacity steppers live only here. A command
 * that runs elsewhere (an upgrade on the Mac, a laptop agent's login) is a
 * copy line.
 */
import type { ReactNode } from "react"
import { Button, Spinner } from "@smthrs/ui"
import { Check, ChevronDown, ChevronRight, Circle, Copy, ExternalLink, Minus, Plus, RotateCw, X } from "lucide-react"
import { Avatar, AvatarStack, Card, GitHubMark } from "../parts"
import { typedOr, useFrame } from "../frame"
import type { Setup } from "../world"
import type { ExtraCardProps } from "./extra"

/* The same GitHub mark the signup button uses (apps/app cards/SignupCards.tsx), in the button's own colour. */
const SignInMark = () => <svg aria-hidden="true" viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M12 .5A11.5 11.5 0 0 0 8.36 22.9c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.05.78 2.12v3.14c0 .31.2.67.8.56A11.5 11.5 0 0 0 12 .5z" /></svg>

type KeyState = NonNullable<Setup["codingKey"]>

/* The fast model, Cerebras through Smithers' infrastructure, and the AI Gateway's provider. */
const FAST = "Cerebras via Smithers"
const GATEWAY = "Vercel"

/* The team's own keys: the coding model's and the AI Gateway's. */
const keyStates = (setup: Setup): ReadonlyArray<KeyState | undefined> => [setup.codingKey, setup.gatewayKey]

/* The Smithers sign-in, in the state vocabulary the key rows share. */
const signIn = (state: Setup["smithers"]): KeyState | undefined =>
  state === "connecting" ? "validating" : state === "connected" ? "saved" : state === "failed" ? "failed" : undefined

/* What a row's state is called: a key validates and saves; a sign-in signs in. */
interface Words { readonly validating: string; readonly saved: string }
const KEY_WORDS: Words = { validating: "Validating", saved: "Saved" }
const SIGN_IN_WORDS: Words = { validating: "Signing in", saved: "Signed in" }

/* The install's own Mac, which needs no HTTPS. */
const local = (address: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(address)

/* Where the quickstart puts HTTPS in front of the install (T-DOC-01). */
const HTTPS_DOCS = "https://smithers.sh/docs/quickstart/#put-https-in-front"

/*
 * Who can reach the install, and at which address (mvp.md §6.1, M-28): Setup's first ask, and Settings' This Mac row.
 * `failed` is an address the owner set that didn't apply: the field keeps it, marked, while the old one stays in effect.
 */
const Reach = ({ id, setup, failed }: { readonly id: "setup" | "settings"; readonly setup: Setup; readonly failed?: string }) => {
  const frame = useFrame()
  return (
    <>
      <span className="mvp-segmented" role="group" aria-label="Who can reach it">
        <button type="button" aria-pressed={setup.listen === "mac"} data-mock={`${id}-listen-mac`}>This Mac only</button>
        <button type="button" aria-pressed={setup.listen === "network"} data-mock={`${id}-listen`}>Network</button>
      </span>
      <input className="mvp-setting-input" aria-label="Address" readOnly aria-invalid={failed !== undefined || undefined}
        value={typedOr(frame, `${id}-address`, failed ?? setup.addresses[0] ?? "")} data-mock={`${id}-address`} />
    </>
  )
}

/* A key never shows: the field is a password field from the first character, and a stored key is all bullets. */
const MASK = "•".repeat(40)

const Mark = ({ n, state }: { readonly n: number; readonly state?: "done" | "failed" }) => (
  <span className="mvp-setup-mark" data-done={state === "done" || undefined} data-failed={state === "failed" || undefined}>
    {state === "done" ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : state === "failed" ? <X size={13} strokeWidth={3} aria-hidden="true" /> : n}
  </span>
)

/* The squash check on the chosen repository. Failed, its label becomes the link to the fix. */
const SquashCheck = ({ repo, off }: { readonly repo: string; readonly off: boolean }) => (
  <span className="mvp-check" data-state={off ? "off" : "ok"} data-mock="setup-check-squash">
    {off ? <X size={14} role="img" aria-label="Failed" /> : <Check size={14} role="img" aria-label="Passed" />}
    {off ? <a href={`https://github.com/${repo}/settings`} target="_blank" rel="noreferrer">Enable squash merging on GitHub<ExternalLink size={12} aria-hidden="true" /></a>
      : <span>Squash merging on GitHub</span>}
  </span>
)

const KeyStatus = ({ state, words = KEY_WORDS }: { readonly state: KeyState | undefined; readonly words?: Words }) => {
  switch (state) {
    case "validating": return <span className="mvp-key-status" data-state={state}><Spinner size="sm" aria-label={words.validating} />{words.validating}</span>
    case "saved": return <span className="mvp-key-status" data-state={state}><Check size={14} aria-hidden="true" />{words.saved}</span>
    case "failed": return <span className="mvp-key-status" data-state={state}><X size={14} role="img" aria-label="Failed" /></span>
    default: return <span className="mvp-key-status" />
  }
}

const KeyInput = ({ input, label, state }: { readonly input: string; readonly label: string; readonly state: KeyState | undefined }) => {
  const frame = useFrame()
  return (
    <input type="password" readOnly aria-label={label} placeholder="API key" data-mock={input} data-state={state}
      aria-invalid={state === "failed" || undefined} value={typedOr(frame, input, state === undefined ? "" : MASK)} />
  )
}

/*
 * One model role: its name, whose it is, its key (or, for the fast model, its Smithers sign-in) and its state.
 * A failed key keeps its field open with its provider's reason.
 */
const ModelRow = ({ role, provider, input, control, words, state, error, children }: {
  readonly role: string
  readonly provider: ReactNode
  /** The key's input id; absent when `control` fills the role instead. */
  readonly input?: string
  /** What fills the role in place of a key: a sign-in button, then the account. */
  readonly control?: ReactNode
  readonly words?: Words
  readonly state: KeyState | undefined
  readonly error: string | undefined
  /** Another way to fill the role, under the key. */
  readonly children?: ReactNode
}) => (
  <div className="mvp-model">
    <span className="mvp-model-role">{role}</span>
    {provider}
    {control ?? (input === undefined ? null : <KeyInput input={input} label={`${role} key`} state={state} />)}
    <KeyStatus state={state} {...(words === undefined ? {} : { words })} />
    {state === "failed" ? <p className="mvp-key-error" role="alert">{error}</p> : null}
    {children}
  </div>
)

/* A progress step names the work while it runs and the result only once it is true. */
const Progress = ({ pending, done, failed, state, pct, note, error }: {
  readonly pending: string
  readonly done: string
  readonly failed: string
  readonly state: "waiting" | "mirroring" | "building" | "ready"
  readonly pct?: number
  readonly note?: string
  readonly error?: string
}) => {
  if (error !== undefined) {
    return (
      <div className="mvp-progress" data-state="failed">
        <span className="mvp-progress-head"><X size={14} aria-hidden="true" />{failed}</span>
        <span className="mvp-progress-error">{error}</span>
        <Button size="sm" variant="outline" data-mock="setup-machine-retry">Retry</Button>
      </div>
    )
  }
  return (
    <div className="mvp-progress" data-state={state}>
      <span className="mvp-progress-head">{state === "ready" ? <Check size={14} aria-hidden="true" /> : null}{state === "ready" ? done : pending}</span>
      {state === "ready" ? null : <span className="mvp-progress-bar"><i style={{ width: `${state === "waiting" ? 0 : pct ?? 0}%` }} /></span>}
      {state === "ready" ? null : <span className="mvp-progress-note">{state === "waiting" ? "Waiting" : note ?? `${pct ?? 0}%`}</span>}
    </div>
  )
}

export const SetupCard = ({ id }: ExtraCardProps) => {
  const frame = useFrame()
  const { world } = frame.state
  const setup = world.setup
  if (setup === undefined) return null
  const owner = world.members.find(each => each.role === "owner")
  /* Signing in through the new App completes the claim: only then is there an owner. */
  const signedIn = setup.github === "signed-in" || setup.github === "app-installed"
  const appCreated = setup.appCreated === true || signedIn
  /* Decided once the network has a public address, or once she moves on to GitHub with this Mac only. */
  const addressDone = appCreated || setup.github !== "todo" || !local(setup.addresses[0] ?? "")
  const appInstalled = setup.github === "app-installed"
  const keysDone = setup.smithers === "connected" && keyStates(setup).every(each => each === "saved")
  const keyFailed = setup.smithers === "failed" || keyStates(setup).includes("failed")
  return (
    <Card id={id} kind="setup" title="Set up Smithers">
      <ol className="mvp-setup">
        <li data-done={addressDone || undefined}>
          <Mark n={1} {...(addressDone ? { state: "done" as const } : {})} />
          <div className="mvp-setup-body">
            <span className="mvp-setup-title">Address</span>
            <span className="mvp-setup-row"><Reach id="setup" setup={setup} /></span>
          </div>
        </li>
        <li data-done={signedIn || undefined}>
          <Mark n={2} {...(signedIn ? { state: "done" as const } : setup.github === "app-failed" ? { state: "failed" as const } : {})} />
          <div className="mvp-setup-body">
            <span className="mvp-setup-title">GitHub</span>
            <span className="mvp-setup-row">
              {signedIn ? <span className="mvp-setup-value"><Avatar world={world} who={owner?.id ?? "maya"} size={18} />{owner?.login}<span aria-hidden="true">·</span><span className="mvp-setup-role">Owner</span></span>
                : appCreated ? <>
                    <span className="mvp-setup-value mvp-setup-done"><Check size={14} aria-hidden="true" />App created</span>
                    <Button size="sm" variant="solid" data-mock="setup-github"><SignInMark />Sign in with GitHub</Button>
                  </>
                : <>
                    {setup.github === "app-failed" ? <span className="mvp-setup-error">{setup.appError ?? "App not created"}</span> : null}
                    <Button size="sm" variant="solid" data-mock="setup-app">Create the GitHub App</Button>
                  </>}
            </span>
          </div>
        </li>
        <li data-done={setup.repository !== undefined || undefined} data-off={!signedIn || undefined}>
          <Mark n={3} {...(setup.repository === undefined ? {} : { state: "done" as const })} />
          <div className="mvp-setup-body">
            <span className="mvp-setup-title">Repository</span>
            {setup.repository === undefined ? (
              <span className="mvp-choices">
                {["acme/api", "acme/web", "acme/infra"].map(name => <button key={name} type="button" className="mvp-choice" data-mock={`setup-repo-${name}`} disabled={!signedIn}>{name}</button>)}
              </span>
            ) : (
              <span className="mvp-setup-row">
                <span className="mvp-setup-value mvp-mono">{setup.repository}</span>
                {appInstalled ? <span className="mvp-check" data-state="ok"><Check size={14} role="img" aria-label="Passed" /><span>App installed</span></span> : null}
                <SquashCheck repo={setup.repository} off={setup.squash === false} />
              </span>
            )}
          </div>
        </li>
        <li data-done={keysDone || undefined} data-off={setup.repository === undefined || undefined}>
          <Mark n={4} {...(keysDone ? { state: "done" as const } : keyFailed ? { state: "failed" as const } : {})} />
          <div className="mvp-setup-body">
            <span className="mvp-setup-title">Model access</span>
            <div className="mvp-models">
              <ModelRow role="Fast model" provider={<span className="mvp-model-name">{FAST}</span>} state={signIn(setup.smithers)} words={SIGN_IN_WORDS} error={setup.keyError}
                control={setup.smithers === "connected"
                  ? <span className="mvp-model-control"><Avatar world={world} who={owner?.id ?? "maya"} size={18} />{owner?.login}</span>
                  : <span className="mvp-model-control"><Button size="sm" variant="solid" data-mock="setup-smithers" disabled={setup.repository === undefined}><SignInMark />Sign in to Smithers</Button></span>} />
              <ModelRow role="Coding model" input="setup-coding" state={setup.codingKey} error={setup.keyError}
                provider={<button type="button" className="mvp-select mvp-model-name" aria-haspopup="listbox" aria-label={`Provider: ${setup.provider}`} data-mock="setup-provider-choice">
                  <span>{setup.provider}</span><ChevronDown size={13} aria-hidden="true" /></button>}>
                {setup.codingKey === "saved" ? null
                  : <p className="mvp-model-alt">or<Button size="sm" variant="outline" data-mock="setup-chatgpt">Sign in with ChatGPT</Button></p>}
              </ModelRow>
              <ModelRow role="AI Gateway" provider={<span className="mvp-model-name">{GATEWAY}</span>} input="setup-gateway" state={setup.gatewayKey} error={setup.keyError} />
            </div>
          </div>
        </li>
      </ol>
      {setup.repository === undefined ? null : (
        <div className="mvp-setup-progress">
          <Progress pending="Mirroring source" done="Source ready" failed="Source failed" state={setup.source} {...(setup.sourcePct === undefined ? {} : { pct: setup.sourcePct })} />
          <Progress pending="Preparing machine" done="Machine ready" failed="Machine failed" state={setup.machine}
            {...(setup.machinePct === undefined ? {} : { pct: setup.machinePct })}
            {...(setup.machineNote === undefined ? {} : { note: setup.machineNote })}
            {...(setup.machineError === undefined ? {} : { error: setup.machineError })} />
        </div>
      )}
    </Card>
  )
}

/* ── Settings ────────────────────────────────────────────── */

/* What a glyph in Settings means for a key, and for the Smithers sign-in. */
interface AccessWords extends Words { readonly failed: string; readonly none: string }
const ACCESS_KEY_WORDS: AccessWords = { validating: "Validating", saved: "Key saved", failed: "Key failed", none: "No key" }
const ACCESS_SIGN_IN_WORDS: AccessWords = { validating: "Signing in", saved: "Signed in", failed: "Sign-in failed", none: "Not signed in" }

/* One role's provider, with its key's (or sign-in's) state as a glyph. */
const Access = ({ name, state, words = ACCESS_KEY_WORDS }: { readonly name: string; readonly state: KeyState | undefined; readonly words?: AccessWords }) => (
  <span className="mvp-setting-state" data-state={state}>
    {state === "saved" ? <Check size={13} role="img" aria-label={words.saved} />
      : state === "failed" ? <X size={13} role="img" aria-label={words.failed} />
      : state === "validating" ? <Spinner size="sm" aria-label={words.validating} />
      : <Circle size={9} role="img" aria-label={words.none} />}
    {name}
  </span>
)

/* Named by its effect, so a screen reader says what a press does. */
const Stepper = ({ id, label, value, fewer, more }: { readonly id: string; readonly label: string; readonly value: number; readonly fewer: string; readonly more: string }) => (
  <span className="mvp-stepper" role="group" aria-label={label}>
    <button type="button" aria-label={fewer} title={fewer} data-mock={`${id}-fewer`}><Minus size={12} strokeWidth={2.5} aria-hidden="true" /></button>
    <b aria-live="polite">{value}</b>
    <button type="button" aria-label={more} title={more} data-mock={`${id}-more`}><Plus size={12} strokeWidth={2.5} aria-hidden="true" /></button>
  </span>
)

/* A command that runs somewhere else, with Copy. */
const CopyLine = ({ id, text, copied = false }: { readonly id: string; readonly text: string; readonly copied?: boolean }) => (
  <code className="mvp-copy-line">{text}<button type="button" aria-label="Copy" data-mock={id}>
    {copied ? <span className="mvp-copied"><Check size={12} aria-hidden="true" />Copied</span> : <Copy size={13} aria-hidden="true" />}</button></code>
)

export const SettingsCard = ({ id, view }: ExtraCardProps) => {
  const frame = useFrame()
  const { world } = frame.state
  const setup = world.setup
  const address = setup.addresses[0] ?? ""
  const repo = setup.repository ?? world.repo
  /* A change that didn't apply, while the address it would have replaced is still the one in effect. */
  const change = setup.addressChange?.from === address ? setup.addressChange : undefined
  return (
    <Card id={id} kind="settings" title="Settings">
      <dl className="mvp-settings">
        <dt>This Mac</dt>
        <dd className="mvp-this-mac">
          <Reach id="settings" setup={setup} {...(change === undefined ? {} : { failed: change.to })} /><span className="mvp-meta">{setup.memory}</span>
          {change === undefined ? null : (
            <span className="mvp-apply" data-mock="settings-address-failed">
              <span className="mvp-apply-error" role="alert"><X size={13} aria-hidden="true" />{change.reason}</span>
              <Button size="sm" variant="outline" data-mock="settings-address-retry"><RotateCw size={13} aria-hidden="true" />Retry</Button>
              <span className="mvp-apply-now">In effect<code>{change.from}</code></span>
            </span>
          )}
        </dd>
        {address.startsWith("http://") && !local(address) ? <>
          <dt>Notifications</dt>
          <dd><a className="mvp-notify-https" href={HTTPS_DOCS} target="_blank" rel="noreferrer" data-mock="settings-notify-https">Notifications need HTTPS<ExternalLink size={12} aria-hidden="true" /></a></dd>
        </> : null}
        {setup.upgrade === undefined ? null : <>
          <dt>Upgrade</dt>
          <dd><span className="mvp-mono">{setup.upgrade}</span><CopyLine id="copy-upgrade" text="smthrs host upgrade" /></dd>
        </>}
        <dt>Models</dt>
        <dd className="mvp-models-setting">
          <span className="mvp-roles">
            <span>Fast model</span><Access name={FAST} state={signIn(setup.smithers)} words={ACCESS_SIGN_IN_WORDS} />
            <span>Coding model</span><Access name={setup.provider} state={setup.codingKey} />
            <span>AI Gateway</span><Access name={GATEWAY} state={setup.gatewayKey} />
          </span>
          <Button size="sm" variant="outline" data-mock="settings-models">Change</Button>
          {keyStates(setup).includes("failed") ? <span className="mvp-key-error">{setup.keyError}</span> : null}
        </dd>
        <dt>GitHub</dt>
        <dd>
          {setup.github === "app-installed"
            ? <span className="mvp-setting-state" data-state="saved"><Check size={13} aria-hidden="true" />App installed</span>
            : <>
                <span className="mvp-setting-state" data-state="failed"><X size={13} aria-hidden="true" />{setup.appError ?? "App failed"}</span>
                <Button size="sm" variant="outline" data-mock="settings-github-repair">Repair</Button>
              </>}
          <a className="mvp-on-github" href={`https://github.com/${repo}`} target="_blank" rel="noreferrer"><GitHubMark size={12} />{repo}<ExternalLink size={11} aria-hidden="true" /></a>
        </dd>
        <dt>Members</dt>
        <dd>
          <button type="button" className="mvp-door" aria-label="Open Members" title="Open Members" data-mock="settings-members">
            <AvatarStack world={world} who={world.members.map(each => each.id)} max={6} /><ChevronRight size={15} aria-hidden="true" />
          </button>
        </dd>
        <dt>Obsidian folder</dt>
        <dd><input className="mvp-setting-input" aria-label="Obsidian folder" readOnly value={typedOr(frame, "settings-obsidian", setup.obsidian)} data-mock="settings-obsidian" /></dd>
        <dt>Machines</dt>
        <dd><Stepper id="machines" label="Machines" value={world.capacity} fewer="Fewer machines" more="More machines" /></dd>
        <dt>TODOs at once</dt>
        <dd><Stepper id="at-once" label="TODOs at once" value={world.parallel} fewer="Fewer TODOs at once" more="More TODOs at once" /></dd>
        <dt>Laptop agents</dt>
        <dd><CopyLine id="copy-login" text={`smthrs login ${address}`} copied={view === "copied"} /></dd>
      </dl>
    </Card>
  )
}
