/*
 * The `auth` flows. One module per namespace: a lane that adds or edits a
 * flow here touches no other flow module, and Flows.ts registers each block in
 * the aggregator order.
 */
import { Schema } from "effect"
import { flow, NoPayload } from "./Declare"
import type { FlowEntry, FlowRequirement, Namespace, Recommendation } from "../registry"
import type { CommandActions } from "./Declare"

/** The `auth` namespace row: the slash tree lists it in registry.ts NAMESPACES order. */
export const namespace: Namespace = { id: "auth", label: "Sign in", summary: "Sign in and out" }

/** Unmet identity requirements render auth.prompt; only its human button starts OAuth. */
export const requirements: ReadonlyArray<FlowRequirement> = [
  {
    id: "signed-in",
    // Only the definitive signed-out answer defers; unknown/unavailable
    // identity never blocks a command (the seam discipline: gate on
    // answers, not on silence).
    satisfied: (state) => !state.signedOut,
    fulfill: "auth.prompt",
    reason: "Sign in with GitHub first"
  },
  {
    /*
     * A spend the HOST pays for (the Worker's model Test, which spends a
     * deployment key and one turn of the login's budget) needs the session
     * that route asks for; the local app spends the operator's own key on
     * their own machine, so the same act there waits for nobody. Listing what
     * a host holds is free and names this requirement nowhere.
     */
    id: "signed-in-to-spend",
    satisfied: (state) => state.hostSpendsOwnKey !== true || !state.signedOut,
    fulfill: "auth.prompt",
    reason: "Sign in with GitHub first"
  },
  {
    /*
     * Repository reads use the resolved local, public or signed-in source.
     * An unrelated selection cannot authorize the target.
     */
    id: "repo-source",
    satisfied: (state) => !state.signedOut || state.publicRepo === true,
    fulfill: "auth.prompt",
    reason: "Sign in with GitHub, or open a local repository first"
  },
  {
    /*
     * A repository's issues, pull requests and commits read from the resolved
     * target, which signs in. Narrower than repo-source on purpose — an open
     * local checkout authorizes no hosted read.
     */
    id: "repo-read",
    satisfied: (state) => !state.signedOut,
    fulfill: "auth.prompt",
    reason: "Sign in with GitHub first"
  }
]

/** Signed out, sign-in is the only next step. */
export const recommendations: ReadonlyArray<Recommendation> = [
  { name: "sign-in", when: (state) => state.signedOut, exclusive: true, rank: () => 0 }
]

/** The `auth` flows registered as one aggregator block. */
export const authFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  flow({
    /*
     * The OAuth redirect leaves the page (or, natively, opens the system
     * browser): the human's gesture, so user-only — auth.prompt below is the
     * agent's door, rendering this button in the chat.
     */
    name: "sign-in",
    summary: "Sign in",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "sign-in is the human's browser gesture; the agent renders the step with auth.prompt",
    input: NoPayload,
    handler: (_payload, _signal, _call, gesture) => actions.signIn(gesture?.openExternal)
  }),
  flow({
    /*
     * The login screen's second door (Will, 2026-10-03): an email address.
     * Hidden: it belongs to the login screen's form (cards/LoginScreen.tsx), not to
     * the catalog. The controller answers with what this host can do with it.
     */
    name: "auth.email",
    hidden: true,
    summary: "Continue with an email address",
    args: "<email>",
    runtime: ["identity"],
    input: Schema.Struct({ email: Schema.String }),
    handler: ({ email }) => actions.signInWithEmail(email)
  }),
  flow({
    /*
     * The agent's door to login: it cannot run sign-in (user-only —
     * navigation is the human's act), but it CAN render the step. The
     * message's action IS the sign-in button, one click away.
     */
    name: "auth.prompt",
    summary: "Offer the GitHub sign-in step in the chat",
    runtime: ["identity"],
    input: NoPayload,
    handler: () => actions.promptSignIn()
  }),
  flow({
    /* Signing out needs a session: offering it signed out is the clearest
		   case of a listing that names a step the user cannot take (§1.2). */
    name: "sign-out",
    summary: "Sign out of Smithers",
    runtime: ["identity"],
    userOnly: true,
    userOnlyReason: "dropping the human's session is theirs alone",
    requires: ["signed-in"],
    input: NoPayload,
    handler: () => actions.signOut()
  })
]
