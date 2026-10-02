import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../package.json";

const readDoc = (path: string): string => readFileSync(join(import.meta.dir, "../docs", path), "utf8");
const guide = readDoc("guides/use-a-heavy-renderer.md");
const diffReference = readDoc("api.md").split("## Pierre diff view")[1]!.split("## Markdown editor")[0]!;

describe("documented renderer and installation contracts", () => {
  test("the lazy DiffSurface module supplies React.lazy's default export", () => {
    const examples = [...guide.matchAll(/```tsx\n([\s\S]*?)```/g)].map((match) => match[1]!);
    const loader = examples.find((example) => example.includes('import("./DiffSurface")'))!;
    const component = examples.find((example) => example.includes("function DiffSurface("))!;
    expect(loader).toContain('lazy(() => import("./DiffSurface"))');
    // Scan the copyable module itself, rather than accepting a prose promise.
    expect(new Bun.Transpiler({ loader: "tsx" }).scan(component).exports).toContain("default");
  });

  test("the file guide describes automatic workers, bounded startup, fallback and teardown", () => {
    const section = guide.split("## Render one file")[1]!.split("## Attach a terminal")[0]!.replace(/\s+/g, " ");
    expect(section).not.toContain("worker factory the consumer supplies");
    expect(section).toMatch(/`CodeFileView` automatically starts the shared worker pool/);
    expect(section).toContain("Bun and browser worker factories");
    const source = readFileSync(join(import.meta.dir, "../src/adapters/code-view/workerPool.ts"), "utf8");
    const deadline = Number(source.match(/CODE_VIEW_POOL_DEADLINE_MS = ([\d_]+)/)![1]!.replaceAll("_", ""));
    expect(section).toContain(`${deadline / 1000}-second initialization deadline`);
    expect(section).toContain("main thread only when workers are unavailable or the pool fails");
    expect(section).toContain("disposeCodeViewPool");
    expect(section).toContain("after unmounting its code views, while its DOM still exists");
  });

  test("the diff reference describes registered palette selection and its override", () => {
    const prose = diffReference.replace(/\s+/g, " ");
    expect(prose).not.toContain("Syntax token colors stay the bundled Shiki `github-light`");
    for (const contract of ["themeRegistry[palette].syntax", "shikiLight", "shikiDark", "`mode`", "`palette`", "document", "custom unregistered themes"]) {
      expect(prose).toContain(contract);
    }
    expect(diffReference).toContain('<PierreDiffView patch={patch} palette="paper" />');
  });

  test("both installation requirements and copyable dependencies match the React peers", () => {
    const installation = readDoc("installation.md");
    const requirements = installation.split("## Requirements")[1]!.split("## Add the dependency")[0]!;
    const example = JSON.parse(installation.match(/```json\n([\s\S]*?)```/)![1]!);
    expect(requirements).toContain(`\`${manifest.peerDependencies.react}\``);
    expect(requirements).toContain(`\`react-dom ${manifest.peerDependencies["react-dom"]}\``);
    for (const peer of ["react", "react-dom"] as const) {
      expect(example.dependencies[peer]).toBe(manifest.peerDependencies[peer]);
    }
  });
});
