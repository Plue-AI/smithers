import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative as relativePath } from "node:path";
import { fileURLToPath } from "node:url";
import { gateEvent } from "../action/src/gateEvent.ts";
import { parseReviewArgs } from "../src/cli/parseReviewArgs.ts";
import { renderOverviewChart } from "../src/walkthrough/renderOverviewChart.ts";

/**
 * The package overview and contributor guide must describe rc.0.
 *
 * README.md and CONTRIBUTING.md drifted once already: CONTRIBUTING kept
 * documenting the 0.x agent engine, a Codex or Claude Code subprocess selected
 * by `SMITHERS_REVIEW_ENGINE`, for a release that runs no subprocess at all,
 * and README already said the opposite.
 *
 * The check is a name check, not a prose check. Every name below belongs to a
 * mechanism rc.0 deleted, so a document that mentions one is describing
 * something no code reads.
 */

const documents = ["../README.md", "../CONTRIBUTING.md"] as const;

/** Environment variables the 0.x agent engine read and rc.0 does not. */
const removedVariables = [
  "SMITHERS_REVIEW_ENGINE",
  "SMITHERS_REVIEW_MODEL",
  "SMITHERS_REVIEW_CHEAP_MODEL",
  "SMITHERS_REVIEW_FALLBACK_MODEL",
] as const;

/** The CLI agent rc.0 no longer spawns. */
const removedDependency = "@openai/codex";

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

describe("the app's documentation describes rc.0", () => {
  for (const relative of documents) {
    const name = relative.replace("../", "");

    test(`${name} names no 0.x engine variable`, () => {
      const text = read(relative);
      // `SMITHERS_REVIEW_MODEL` is a prefix of nothing shipped, but
      // `SMITHERS_REVIEW_SEAT` and friends are live, so match whole names.
      const mentioned = removedVariables.filter((variable) => new RegExp(`\\b${variable}\\b`).test(text));
      expect({ document: name, mentioned }).toEqual({ document: name, mentioned: [] });
    });

    test(`${name} does not offer the Codex CLI`, () => {
      expect({ document: name, mentions: read(relative).includes(removedDependency) }).toEqual({
        document: name,
        mentions: false,
      });
    });

    test(`${name} documents the seats that exist`, () => {
      const text = read(relative);
      // The positive half: a document that dropped every stale name while
      // saying nothing about seats would pass the checks above and still leave
      // a reader with no way to choose a model.
      expect(text).toContain("SMITHERS_REVIEW_SEAT");
    });
  }
});

const siteGuide = "../../site/src/content/docs/docs/guides/pr-review-action.mdx";

describe("documented review commands", () => {
  test("the guide's comment commands match the action trigger and start a review", async () => {
    const trigger = read("../action/src/gateEvent.ts").match(/const MAGIC_PHRASE = "([^"]+)";/)?.[1];
    if (!trigger) throw new Error("The action trigger constant was not found");
    const commands = read(siteGuide).match(/@[\w-]+ review/g) ?? [];
    expect(commands.length).toBeGreaterThanOrEqual(2);
    for (const command of commands) {
      expect(command).toBe(trigger);
      const maintainer = { login: "octocat", type: "User" };
      expect(await gateEvent({
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: { number: 42, pull_request: {} },
          comment: { body: command, user: maintainer },
          sender: maintainer,
        },
        permissionOf: async () => ({ status: 200, permission: "write" }),
      })).toEqual({ run: true, eventName: "issue_comment", prNumber: 42 });
    }
  });

  for (const relative of ["../README.md", siteGuide, "../src/cli/main.ts", "../docs/commands.md"]) {
    test(`${relative} disables every model-backed step in no-seats examples`, () => {
      const examples = read(relative).split("\n").filter((line) =>
        /^\s*(?:smithers-review|\$\{command\})\s/.test(line) &&
        line.includes("--no-review") && line.includes("--no-narrate")
      );
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        // CLI help separates the command and its description with two spaces.
        const command = example.trim().split(/\s{2,}/)[0]!;
        const args = parseReviewArgs(command.split(/\s+/).slice(1));
        expect({ review: args.review, narrate: args.narrate, quiz: args.quiz }).toEqual({
          review: false,
          narrate: false,
          quiz: "off",
        });
      }
    });
  }
});

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = join(appRoot, "..", "..");

/** Every README under `src/`, as app-relative paths. */
const directoryReadmes = readdirSync(join(appRoot, "src"), { recursive: true, encoding: "utf8" })
  .filter((path) => path === "README.md" || path.endsWith("/README.md"))
  .map((path) => join("src", path));

/**
 * Repository files a document cites: relative Markdown link targets, plus
 * backticked paths into this repository. `.smithers/`, `.github/` and `apps/`
 * paths start at the repository root; `src/`, `action/`, `tests/` and `docs/`
 * start at this app. The README tells readers to create a workflow file in
 * their own repository, so `.github/` is checked in CONTRIBUTING.md only.
 */
function citedPaths(document: string): string[] {
  const text = readFileSync(join(appRoot, document), "utf8");
  const links = [...text.matchAll(/\]\(((?!https?:|mailto:|#)[^)\s#]+)\)/g)].map((match) =>
    join(appRoot, dirname(document), match[1]!)
  );
  const rootPrefixes = document === "CONTRIBUTING.md" ? "\\.smithers|\\.github|apps" : "\\.smithers|apps";
  const backticked = [...text.matchAll(new RegExp(`\`((?:${rootPrefixes}|src|action|tests|docs)/[\\w./-]*)\``, "g"))]
    .map((match) => match[1]!)
    .map((path) => /^(?:\.smithers|\.github|apps)\//.test(path) ? join(repoRoot, path) : join(appRoot, path));
  return [...links, ...backticked];
}

describe("the app's documentation points at things that exist", () => {
  for (const document of ["README.md", "CONTRIBUTING.md"]) {
    test(`${document} cites only files that exist`, () => {
      const cited = citedPaths(document);
      expect(cited.length).toBeGreaterThan(0);
      const missing = cited.filter((path) => !existsSync(path)).map((path) => relativePath(repoRoot, path));
      expect({ document, missing }).toEqual({ document, missing: [] });
    });
  }

  test("every documented import of this package is an entry in its exports map", () => {
    const manifest = JSON.parse(read("../package.json")) as { name: string; exports: Record<string, string> };
    const documented = ["CONTRIBUTING.md", "README.md", ...directoryReadmes].flatMap((document) =>
      [...readFileSync(join(appRoot, document), "utf8").matchAll(/[`"]((?:@smthrs\/review|smithers-review)\/[\w/-]+)[`"]/g)]
        .map((match) => ({ document, specifier: match[1]! }))
    );
    expect(documented.length).toBeGreaterThan(0);
    const unresolved = documented.filter(({ specifier }) =>
      !specifier.startsWith(`${manifest.name}/`) ||
      !(`./${specifier.slice(manifest.name.length + 1)}` in manifest.exports)
    );
    expect(unresolved).toEqual([]);
  });

  test("the docs name only the domain alchemy.run.ts deploys", () => {
    const deployed = read("../alchemy.run.ts").match(/domain: \{ name: "([^"]+)"/)?.[1];
    if (!deployed) throw new Error("alchemy.run.ts declares no custom domain");
    const named = ["CONTRIBUTING.md", ...directoryReadmes].flatMap((document) =>
      [...readFileSync(join(appRoot, document), "utf8").matchAll(/\breview\.[a-z0-9-]+\.[a-z]+\b/g)]
        .map((match) => ({ document, host: match[0] }))
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(({ host }) => host !== deployed)).toEqual([]);
  });
});

/**
 * Prose about what the code does, checked against the code that does it.
 * Each case pins one claim a review found contradicting the implementation.
 */
describe("the app's comments describe the code beside them", () => {
  const overview = renderOverviewChart([
    { path: "src/a.ts", status: "modified", insertions: 3, deletions: 1, diff: "", reviewed: true, excludeReason: "" },
  ]);

  for (const document of ["../CONTRIBUTING.md", "../src/walkthrough/renderWalkthroughHtml.ts"]) {
    test(`${document.replace("../", "")} calls the overview chart SVG only if it draws SVG`, () => {
      const saysSvg = /\bSVG\s+(?:\*\s+)?chart\b/.test(read(document));
      expect({ document, saysSvg }).toEqual({ document, saysSvg: overview.includes("<svg") });
    });
  }

  test("the seat policy names the module in this app that reads the credential", () => {
    const owner = read("../src/workflow/reviewSeats.ts").match(/`([\w.]+\.ts)`\s+(?:\*\s+)?owns the credential half/)?.[1];
    expect(owner).toBeDefined();
    expect(read(`../src/workflow/${owner}`)).toContain("ANTHROPIC_API_KEY");
  });

  test("the exclude-reason labels cite the module that produces the reasons", () => {
    const source = read("../src/walkthrough/humanizeExcludeReason.ts");
    const cited = source.match(/Values produced by (\w+)[\s\S]*?\bin\s+(?:\/\/\s*)?(\.\.?\/[\w./-]+\.ts)/);
    expect(cited).not.toBeNull();
    const [, producer, module] = cited!;
    expect(read(`../src/walkthrough/${module}`)).toContain(`function ${producer}(`);
  });
});
