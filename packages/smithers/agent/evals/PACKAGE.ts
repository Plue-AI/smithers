import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/agent/evals"

const standard = BuildAndCheckTypeScriptPackage({ cwd })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = standard

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "ci-log-control-characters",
      title: "Every string that reaches a CI log, gate summary or error message is free of C0 controls and DEL",
      threat:
        "An author of a committed baseline, suite fixture or target flow output forges GitHub Actions workflow commands or rewrites the CI log of the repository running the gate.",
      lookFor: [
        "A string field read from baseline JSON or a suite fixture that is type-checked but never passed to controlCharacter, such as the top-level baseline suite.",
        "An EvalError message interpolating a baseline, suite, scorer or step-key value without flattenControlCharacters.",
        "A gate or runner summary path that bypasses ciGrade's flattening, or a sanitizer that misses C1 controls such as U+009B or bidi overrides."
      ],
      paths: [
        "src/Baseline.ts",
        "src/Suite.ts",
        "src/Regression.ts",
        "src/Gate.ts",
        "src/Runner.ts",
        "src/internal/controlCharacters.ts"
      ]
    },
    {
      id: "markdown-report-escaping",
      title: "The Markdown report renders target-controlled values as inert text",
      threat:
        "A target flow or scorer that controls case failures, step keys or reasons injects links, images, HTML or table rows into a report a reviewer reads on a PR.",
      lookFor: [
        "A report value written into a heading or table row without passing through cell().",
        "A GFM or HTML metacharacter missing from the cell() escape class, or truncation that splits an escape sequence.",
        "Numbers rendered with toFixed from a value that could be non-finite or non-numeric."
      ],
      paths: ["src/Report.ts"]
    },
    {
      id: "untrusted-parse-bounds",
      title: "Parsing a baseline or JSON Lines fixture is bounded and yields only validated plain data",
      threat:
        "A contributor who commits a crafted fixture or baseline exhausts CI memory or smuggles prototype-polluting or getter-bearing objects into the evaluation.",
      lookFor: [
        "Baseline.load parsing text with no length cap while Suite.fromJsonLines enforces limits.fixtureLength.",
        "A decoded record kept by reference, spread with unknown keys, or assigned through __proto__ instead of rebuilt field by field.",
        "Case input or expected that skips validateData, structuredClone and freezeData before reaching an executor or scorer."
      ],
      paths: ["src/Baseline.ts", "src/Suite.ts"]
    },
    {
      id: "report-serialization-budget",
      title: "Serializing arbitrary target output terminates within fixed node, depth and byte budgets",
      threat:
        "A target flow returns cyclic, deeply shared, huge or getter-throwing output and hangs or crashes the evaluation process on the CI runner.",
      lookFor: [
        "A walk branch that recurses or allocates before decrementing budget.nodes or budget.bytes.",
        "A getter, toString or Symbol.toPrimitive on target output invoked outside a try that maps it to [unreadable].",
        "A Map key, Set member or Error property traversed without the seen-set cycle guard."
      ],
      paths: ["src/internal/CanonicalJson.ts", "src/Report.ts"]
    },
    {
      id: "report-secret-exposure",
      title:
        "Reports and errors do not publish case inputs, ground truth or target output beyond what the caller opted into",
      threat:
        "A reader of CI logs or PR comments reads secrets or private data carried in eval case inputs, expected values or model outputs.",
      lookFor: [
        "Report.json or markdown embedding case input, expected or binding context in addition to the documented execution.output.",
        "An EvalError cause or message that stringifies a whole case, execution or scorer request.",
        "A span attribute in Runner carrying input or output rather than only the case name."
      ],
      paths: ["src/Report.ts", "src/Runner.ts", "src/EvalError.ts"]
    },
    {
      id: "gate-fails-closed",
      title: "A regression gate never passes on missing, inconclusive, foreign or failed observations",
      threat:
        "A target or scorer author ships a regression to main because the gate reads an absent, NaN or foreign-suite score as a pass.",
      lookFor: [
        "A verdict path that returns exit code 0 when observations are missing, inconclusive or the case errored.",
        "A score comparison that treats NaN, a score outside [0, 1] or a scorer-returned non-number as passing.",
        "A baseline record matched by a non-injective key, or a binding matched to a flow by anything other than reference identity."
      ],
      paths: ["src/Gate.ts", "src/Regression.ts", "src/Runner.ts", "src/Trials.ts", "src/internal/tupleKey.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
