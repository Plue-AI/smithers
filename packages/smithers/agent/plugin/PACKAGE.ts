import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/agent/plugin"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  testData: ["test/fixtures/*.mjs", "test/fixtures/*.cjs"],
  cwd
})

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "inert-plugin-admission",
      title: "Plugin, option, and hook-catalog admission never runs caller code outside a caught boundary",
      threat:
        "A hostile plugin preset uses accessors, proxies, or exotic prototypes to run code or smuggle values past validation into the host that loads it.",
      lookFor: [
        "A read of a caller-supplied property through ordinary access instead of Object.getOwnPropertyDescriptor with a `value` check in ownData, snapshotHook, or snapshotCatalog.",
        "A Reflect.ownKeys or descriptor call on caller input outside the Effect.try blocks in resolve, so a throwing Proxy trap escapes as a defect instead of invalid_plugin.",
        "A snapshot that keeps a reference to the caller's record, hooks object, or preset array instead of a frozen copy, letting the caller mutate it after admission.",
        "A plugin field other than name, version, enforce, apply, layer, hooks accepted without the allowed-set check.",
        "An apply predicate called outside the Effect.try in included, or handed a config that is not the frozen admitted snapshot.",
        "A plugin layer built without the Layer.catchCause wrapper in mergePluginLayers, so a failing layer escapes as a defect instead of layer_failed."
      ],
      paths: ["src/Resolve.ts", "src/Hooks.ts", "src/Plugin.ts", "src/internal/mergePluginLayers.ts"]
    },
    {
      id: "startup-resource-bounds",
      title: "Every startup input is bounded before it is enumerated",
      threat:
        "A plugin preset or config supplied by an untrusted package exhausts memory or CPU of the engine or harness at startup.",
      lookFor: [
        "flatten enumerating array keys or pushing child frames before the maximumPluginInputNodes check that accounts for queued frames.",
        "A cycle or repeated preset array that bypasses the WeakSet check and loops.",
        "Handler or plugin counts compared after the work they bound instead of before.",
        "parallelConcurrency accepted outside 1..maximumParallelConcurrency or as a non-integer.",
        "A diagnostic path or message built from an unbounded caller key without diagnosticKey or boundedPath."
      ],
      paths: ["src/Resolve.ts", "src/internal/Boundary.ts", "src/Plugins.ts"]
    },
    {
      id: "config-json-boundary",
      title: "Plugin configuration is strict, bounded, detached JSON and cannot claim engine policy",
      threat:
        "A plugin's config waterfall patch pollutes prototypes, aliases a mutable object, or sets engine, retry, store, or plugins policy that other plugins or the engine then trust.",
      lookFor: [
        "A `__proto__`, `constructor`, or `prototype` key surviving Boundary.admit or mergeRecords into a record with Object.prototype.",
        "Config.merge reusing a known patch without copying it, so the patch tree aliases the retained base.",
        "mergeRecords trusting snapshots.get on an object that was not produced by admission, yielding undefined totals or skipped limits.",
        "A reserved root key (engine, retry, store, plugins) accepted after a waterfall merge because only the initial snapshot checks it.",
        "admittedConfigs membership granted to a caller-constructed object instead of only to detached admission output."
      ],
      paths: ["src/Config.ts", "src/internal/Boundary.ts", "src/Kernel.ts"]
    },
    {
      id: "cache-identity-integrity",
      title: "Sealed cache identity covers every selected plugin and cannot be forged or overridden",
      threat:
        "A plugin or caller forges the cache environment so cached activity results from one plugin composition are replayed under another, serving another run's stale or tampered output.",
      lookFor: [
        "A selected plugin without a version admitted while cacheEnvironment is set.",
        "name@version escaping that lets two distinct (name, version) pairs produce the same identity string.",
        "Layer.provideMerge(merged, environment) in mergePluginLayers letting a plugin layer that provides Action.layerCacheEnvironment replace the sealed environment read by Action.CurrentCacheEnvironment.",
        "Plugin identities computed from the unfiltered or unsorted input instead of the resolved plugin list."
      ],
      paths: ["src/internal/snapshotCacheEnvironment.ts", "src/internal/mergePluginLayers.ts", "src/Resolve.ts"]
    },
    {
      id: "dispatch-isolation",
      title: "Hook dispatch contains plugin failures and never runs a handler under the wrong kind",
      threat:
        "One misbehaving plugin crashes the host, skips another plugin's enforce-pre handler, or has its handler run with semantics its declaration never promised.",
      lookFor: [
        "A handler invocation outside runHandler's Effect.sync plus catchCause, so a throw becomes a defect.",
        "A kind check skipped for a hook absent from resolved.kinds while handlers exist for it.",
        "parallel dispatch that drops or swallows a failure instead of returning it in observerErrors.",
        "Ordering that lets an enforce or order value from input override the documented pre, normal, post partition.",
        "A PluginError cause or message that embeds handler arguments or config values that may hold secrets."
      ],
      paths: ["src/Plugins.ts", "src/Kernel.ts", "src/Hooks.ts", "src/PluginError.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
