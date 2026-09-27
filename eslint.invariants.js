// Repository invariants a type cannot state. Shared by every package's
// `eslint.config.js` the same way `eslint.jsdoc.js` is.
//
// Each invariant closes one defect class that a review found repeated across
// packages and fixed by hand. A rule id on its own teaches nothing at 2am, so
// every message says what the shape does wrong, what the house writes instead,
// and where a correct example lives.
//
// Wiring, at the end of a package's config, after `...jsdocConvention`:
//
//   import { ambientAuthority, invariants, swallowedCause, uninstalledSafety } from "../../eslint.invariants.js"
//   ...
//   ...invariants(uninstalledSafety, swallowedCause, ambientAuthority)
//
// `invariants` is a function rather than a spreadable array because all three
// invariants are expressed with `no-restricted-syntax`, and flat config does
// not merge one rule's options across config objects: the last object matching
// a file replaces the options of every earlier one. Three fragments spread
// side by side would leave only the last one live, and the other two would sit
// in the tree looking enforced. `invariants` merges the selectors into one
// object so that cannot happen, and a package holding only some of them names
// exactly the ones it holds, which makes the gap visible in the config.
//
// Scope is `src/**` throughout. Tests are deliberately outside: `test/**` is
// not matched at all, and `src/test/**` (the in-package doubles under
// `packages/smithers/control/src/test`, `packages/smithers/flows/kernel/src/test`, and eight more) is
// ignored, because an uninstalled service and a discarded failure are what a
// double is for.

/** Shipped source, never a test. Every invariant reads this scope. */
const files = ["src/**/*.ts"]
const ignores = ["src/**/*.test.ts", "src/test/**"]

/**
 * Rule 1, uninstalled safety.
 *
 * A safety service that ships with a no-op default lets a composition root
 * omit it and say nothing. The class produced this review's P0.
 *
 * Four spellings are named because four exist in the tree today, each verified
 * present: `QuotaPolicy.layerUnclassified` and `Budget.layerUnbounded` in
 * `packages/smithers/agent` (the explicit names the rename settled on, replacing the
 * old no-op defaults), `GrantStore.layerNoop` in `packages/smithers/flows/kernel`, and
 * `ControlRpcs.layerNoopAuth` in `packages/smithers/control`, which is the same class
 * wearing a different noun: an unauthenticated control plane.
 *
 * The last selector bans the *shape* rather than a name: any `layerNoop` or
 * `makeNoop` standing as a default parameter value. Names go stale, and the
 * shape is what let the omission happen in the first place.
 */
const noOpDefault =
  "A no-op default means a caller that omits this argument silently gets the uninstalled service, and nothing in the composition says so. Make the parameter required, so a composition root has to name what it installs, or default it to the real layer. A safety layer dropped by forgetting an argument is the exact failure this rule exists for."

export const uninstalledSafety = {
  name: "uninstalled-safety",
  selectors: [{
    selector: "MemberExpression[property.name=/^(layerUnclassified|makeUnclassified|layerUnbounded|makeUnbounded)$/]",
    message:
      "This uninstalls a safety service. `QuotaPolicy.layerUnclassified` stops classifying quota failures, so a rate-limited seat reads as a crash and the run never parks. `Budget.layerUnbounded` removes the spend ceiling, so nothing stops a loop from burning the whole envelope. A production composition names the installed spelling instead: `QuotaPolicy.layerDefault()` and `Budget.layerFromEnvelope`, both wired in `packages/smithers/src/NodeControl.ts`. Doubles belong under `test/**` or `src/test/**`, which this rule does not reach."
  }, {
    selector: "MemberExpression[object.name='GrantStore'][property.name=/^(layerNoop|makeNoop)$/]",
    message:
      "`GrantStore.layerNoop` answers yes to every capability request, so the filesystem and the shell above it run unguarded and the kernel records no refusal. Build the real store from the workspace root: `NodeControl.layerGrantStore(root)` is the production one, and it is the single store `layerGuardedPlatform` hands to both the filesystem and the spawner so the two can never disagree about what is allowed."
  }, {
    selector: "MemberExpression[property.name='layerNoopAuth']",
    message:
      "`ControlRpcs.layerNoopAuth` authenticates every request as a principal the server invented, so it is an authentication bypass anywhere the bind is reachable. `ControlRpcs.layerBearerAuth` is the installed spelling. If the bind really is loopback-only, disable this one line and name the check that makes it safe, the way `NodeControl.layerServerNoopAuth` throws on a non-loopback host before it gets here."
  }, {
    // `(layers = Ns.layerNoop)`. Stated separately from the call form below
    // because esquery's `>` is a child combinator: in `(layers =
    // Ns.layerNoop())` the member expression is the AssignmentPattern's
    // grandchild, and one selector cannot span both depths.
    selector: "AssignmentPattern > MemberExpression[property.name=/^(layerNoop|makeNoop|layerUnclassified|layerUnbounded)$/]",
    message: noOpDefault
  }, {
    // `(layers = Ns.layerNoop())`.
    selector:
      "AssignmentPattern > CallExpression > MemberExpression[property.name=/^(layerNoop|makeNoop|layerUnclassified|layerUnbounded)$/]",
    message: noOpDefault
  }, {
    // The selectors above see `Ns.layerUnbounded`. This sees the other
    // spelling, a bare named import, which loses the namespace that said which
    // service was being uninstalled.
    //
    // `no-restricted-imports` with `importNames` is the rule built for this and
    // is deliberately not used: it treats `import * as Ns from "..."` as
    // possibly containing every restricted name, and this house imports
    // namespaces almost exclusively, so it reports every import in the repo.
    // An `ImportSpecifier` selector names the one thing meant.
    selector:
      "ImportSpecifier[imported.name=/^(layerUnclassified|makeUnclassified|layerUnbounded|makeUnbounded|layerNoopAuth)$/]",
    message:
      "Importing a safety opt-out by bare name loses the namespace that said which service it uninstalls. Production compositions install the real layer: `QuotaPolicy.layerDefault()`, `Budget.layerFromEnvelope`, `ControlRpcs.layerBearerAuth`. A test that needs the opt-out belongs under `test/**` or `src/test/**`."
  }]
}

/**
 * Rule 2, swallowed causes.
 *
 * A handler that ignores what it caught erases the failure: nothing logs it,
 * nothing counts it, and the caller cannot tell the effect from one that
 * succeeded. The class produced at least six defects in one review, including
 * a scheduler that died and never fired another trigger.
 *
 * The `catchCause` selector matches the half that is mechanically decidable: a
 * handler taking no parameter cannot have inspected the cause, so it cannot
 * have told an interrupt from a defect.
 *
 * The other half, a handler that does take the cause and then never guards it,
 * is not expressible here and is deliberately left out rather than shipped as
 * a selector that quietly matches nothing. esquery's `:has` reaches only the
 * handler's own subtree, so it cannot see a guard that lives in a helper the
 * handler calls, and it cannot tell a handler that recovers from one that
 * re-raises with `Effect.failCause`. Written as a blanket ban it fired on 46
 * sites across 29 files, most of them correct. Reviewers still own that half.
 */
export const swallowedCause = {
  name: "swallowed-cause",
  selectors: [{
    selector:
      "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.object.name='Effect'][body.property.name='void']",
    message:
      "This handler ignores what it caught and returns success, so the failure leaves no record at all: no log line, no metric, nothing that distinguishes it from an effect that worked. That is how a scheduler stopped firing triggers with an empty log. Take the error and record it, `Effect.catch((error) => Effect.logWarning(\"<what was attempted>\", error))`, or narrow to the one failure you meant to absorb with `Effect.catchTag` or `Effect.catchIf`. If dropping it is genuinely right, disable this line and write the sentence that says why."
  }, {
    selector:
      "CallExpression[callee.property.name='catch'] > ArrowFunctionExpression[body.type='Literal'][body.value='']",
    message:
      "Recovering to an empty string hands the caller a value it cannot tell apart from a real empty result, and the failure is gone. Return an absence the caller has to check, `Option.none()` or `undefined`, or log the failure before substituting a default."
  }, {
    selector:
      "CallExpression[callee.property.name=/^catchCause/] > :matches(ArrowFunctionExpression, FunctionExpression)[params.length=0]",
    message:
      "A `catchCause` handler that takes no parameter cannot have looked at the cause, so it turns a cancellation into a success and a defect into a silent one. The house pattern takes the cause and branches on `Cause.hasInterruptsOnly` before it recovers: `packages/smithers/flows/flow/src/Flow/Runtime.ts` records a real failure and re-interrupts otherwise, and `packages/smithers/flows/engine-store/src/internal/RunCoordinator.ts` logs a failed drain but stays quiet on an interrupt. Accept the cause, then either re-raise it or log why it is safe to drop."
  }]
}

/**
 * Rule 3, ambient defaults.
 *
 * Ambient reads are legitimate at process and child-spawn boundaries. The
 * dangerous shape is a default parameter: the signature looks injectable,
 * but an omitted argument silently selects process-wide state. The class
 * caused a real defect when jj operations resolved checkpoints against the
 * repository the operator's shell happened to be sitting in.
 *
 * Two selectors are required because esquery's `>` is a child combinator.
 * `process.env` is the AssignmentPattern's child, while the member expression
 * in `process.cwd()` is under a CallExpression.
 */
const ambientDefault =
  "`process.cwd()` or `process.env` as a default parameter makes an injectable API lie: omitting one argument silently selects process-wide state, so a configured workspace or hermetic environment can be ignored with no error. This is how jj checkpoint operations once targeted the repository the shell happened to start in. Make the parameter required and thread the configured root or environment. If process state is genuinely the host default, spell that decision with the package's named `Environment.ambientWorkingDirectory()` or `Environment.ambientEnvironment()` accessor."

export const ambientAuthority = {
  name: "ambient-authority",
  selectors: [{
    // `(cwd = process.cwd())`.
    selector: "AssignmentPattern > CallExpression > MemberExpression[object.name='process'][property.name='cwd']",
    message: ambientDefault
  }, {
    // `(environment = process.env)`.
    selector: "AssignmentPattern > MemberExpression[object.name='process'][property.name='env']",
    message: ambientDefault
  }]
}

/**
 * Rule 4, POSIX host paths.
 *
 * `Path.layer` from `effect/Path` is POSIX-only. Providing it under code that
 * resolves host paths breaks every Windows drive root: POSIX `resolve` treats
 * `D:\a` as relative and prefixes the working directory, and `dirname` of it
 * is `.`. Host-path code reads the ambient `Path.Path` the composition root
 * provides (`NodePath.layer` on Node). Opt-in: a package whose `src` only ever
 * handles host paths holds this rule; a browser, sandbox-guest, or in-memory
 * host that is POSIX by construction does not.
 * The selector matches by identifier name, not import source, so hold it only
 * in a package where `Path` always means `effect/Path`.
 */
export const hostPath = {
  name: "host-path",
  selectors: [{
    selector: "MemberExpression[object.name=/^(Path|EffectPath)$/][property.name='layer']",
    message:
      "`Path.layer` from `effect/Path` is POSIX-only, so a Windows drive root resolves under the working directory and host confinement and fsync walk the wrong paths (issue #2302). Read the ambient `Path.Path` instead and require it in the layer, so the composition root provides the host's one (`NodePath.layer` on Node)."
  }]
}

/**
 * The chosen invariants, as flat config.
 *
 * Every chosen invariant's selectors land in one `no-restricted-syntax` entry,
 * because flat config replaces a rule's options rather than merging them. When
 * an invariant exempts entry points, a second config object re-states the
 * remaining selectors for exactly those files, so exempting `process.env` in
 * `src/bin.ts` does not also stop banning no-op safety layers there.
 */
export const invariants = (...chosen) => {
  const selectors = chosen.flatMap((invariant) => invariant.selectors)
  const rules = { "no-restricted-syntax": ["error", ...selectors] }

  const exempt = chosen.filter((invariant) => invariant.entryPoints !== undefined)
  if (exempt.length === 0) return [{ files, ignores, rules }]

  const exemptNames = new Set(exempt.map((invariant) => invariant.name))
  const kept = chosen.filter((invariant) => !exemptNames.has(invariant.name))
  return [
    { files, ignores, rules },
    {
      files: exempt.flatMap((invariant) => invariant.entryPoints),
      ignores,
      rules: { ...rules, "no-restricted-syntax": ["error", ...kept.flatMap((invariant) => invariant.selectors)] }
    }
  ]
}
