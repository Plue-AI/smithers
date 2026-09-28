import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/testing"

const standard = BuildAndCheckTypeScriptPackage({ cwd })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = standard

const securityReview = Smithers.SecurityReview({
  cwd,
  checks: [
    {
      id: "fixture-secret-capture",
      title: "Recorded fixtures never persist credentials or private transcript data",
      threat:
        "Anyone who can read a committed fixture reads API keys, tokens, or private user text that a recording run captured from the live model exchange.",
      lookFor: [
        "recordedRequest in src/Fixture.ts copying system, message, tool-result, or tool-call argument text verbatim with no redaction hook or secret scan.",
        "recordedFailure in src/RecordingModel.ts storing a provider ModelError message, path, or requestId that can echo a key or auth header.",
        "FixtureStore.makeFile writing the fixture or its .journal with default permissions instead of owner-only mode.",
        "CachedModel or RecordingModel recording a call whose request carries headers, credentials, or provider options beyond the projected ModelRequest fields."
      ],
      paths: ["src/Fixture.ts", "src/RecordingModel.ts", "src/CachedModel.ts", "src/FixtureStore.ts"]
    },
    {
      id: "fixture-store-path-safety",
      title: "The file fixture store writes only the fixture path and its own sidecars",
      threat:
        "A contributor who plants a symlink at <fixture>.journal, .lock, or the staging path makes a test run overwrite or truncate an arbitrary file the test user can write.",
      lookFor: [
        "appendFile or truncate on `${path}.journal` following a symlink instead of opening with O_NOFOLLOW or checking lstat first.",
        "rename of the staging file over a path that is a symlink, or a staging name that is not unique per write.",
        "readFixture truncating the journal before every complete line has been validated, losing recorded calls on a malformed file.",
        "A stale .lock directory from a killed run silently taken over instead of failing with a path-naming defect."
      ],
      paths: ["src/FixtureStore.ts"]
    },
    {
      id: "fixture-decode-untrusted",
      title: "Fixture and journal decoding rejects hostile input with a typed defect",
      threat:
        "A fixture file edited in a pull request crashes, hangs, or prototype-pollutes the test process that decodes it.",
      lookFor: [
        "JSON.parse output reaching snapshot, owned, or canonicalize before decode(...) validates it against the Fixture schema.",
        "A walk in src/internal/Structural.ts or FixtureStore.owned that recurses past maximumDepth or assigns a __proto__ or constructor key onto a live prototype.",
        "A journal index check that accepts a negative, non-integer, gapped, or out-of-range index.",
        "Schema.Json or Schema.Record fields that accept unbounded nesting or size without the 128-level canonicalize cap."
      ],
      paths: ["src/Fixture.ts", "src/FixtureStore.ts", "src/internal/Structural.ts"]
    },
    {
      id: "replay-live-fallthrough",
      title: "A replay double never calls a live model or accepts a mismatched recording",
      threat:
        "A fixture miss in CI spends the maintainers' live model credentials or replays a recording made against another model, so a test certifies behavior it never observed.",
      lookFor: [
        "RecordedModel returning anything but UnscriptedModelError or ReplayHarnessMismatchError for an unmatched request or a model id mismatch.",
        "CachedModel falling through to options.live on a miss with no switch that forbids recording in CI.",
        "canonicalRequestDigest omitting a request field such as tools, params, toolChoice, or serverTools, so two different requests share a recording.",
        "A replayed recorded failure that is not stamped with modelErrorTag and therefore bypasses the caller's quota or refusal handling."
      ],
      paths: ["src/RecordedModel.ts", "src/CachedModel.ts", "src/Fixture.ts", "src/ModelLike.ts"]
    },
    {
      id: "test-host-isolation",
      title: "The deterministic TestHost cannot reach the real filesystem, network, shell, or jj",
      threat:
        "Code under test that believes it runs on TestHost reads or writes the developer's real files, makes real HTTP calls, or runs real shell commands.",
      lookFor: [
        "TestHost.layer providing any Node platform layer, a real HttpClient, or a real ChildProcessSpawner instead of layerNoop, makeStubBash, and BrowserJj.layerUnsupported.",
        "TestHost.layer backing BrowserFileSystem with anything other than makeMemoryFs, such as a filesystem mounted on the host disk.",
        "makeStubBash matching a command by prefix or pattern, or through a prototype key, instead of Object.hasOwn exact lookup.",
        "HostSuite capability cases that pass when the host silently performs the real side effect."
      ],
      paths: ["src/TestHost.ts", "src/HostSuite.ts"]
    },
    {
      id: "process-probe-exec",
      title: "Process probes and fault injection run fixed argv and signal only the intended pid",
      threat:
        "A caller-supplied pid or column turns a fault suite into a command injection or a signal sent to every process the test user owns.",
      lookFor: [
        "queryWindows interpolating pid into the PowerShell -Command script without checking Number.isInteger(pid) && pid > 0.",
        "ProcessTable.query spawning ps through a shell or with an inherited PATH, or queryWindows resolving pwsh from the caller's process.env PATH.",
        "killProcess, killGroup, or isGroupAlive reaching process.kill with 0, -1, or a negated non-positive value.",
        "skewClock replacing globalThis.Date or Date.now without a restore that runs on test failure."
      ],
      paths: ["src/ProcessTable.ts", "src/Faults.ts"]
    },
    {
      id: "assertion-message-leak",
      title: "Test failures name the failing request or value without dumping transcripts",
      threat:
        "Anyone who can read CI logs reads full system prompts, conversation text, or secret-bearing journal values printed by a failed assertion.",
      lookFor: [
        "An error in src/TestingError.ts or a defect in RecordedModel carrying the whole request, messages, or tool schemas instead of counts and names.",
        "PlanAssertions inspect or JournalAssertions failure messages rendering an entire payload or output value into the message string.",
        "Divergence or ScoreSuite reports embedding raw model output or fixture contents in text printed on failure."
      ],
      paths: [
        "src/TestingError.ts",
        "src/RecordedModel.ts",
        "src/PlanAssertions.ts",
        "src/JournalAssertions.ts",
        "src/Divergence.ts",
        "src/internal/ScoreSuite.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
