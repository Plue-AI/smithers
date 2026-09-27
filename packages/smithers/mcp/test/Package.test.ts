import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

describe("package manifest and README", () => {
  it("points the README at the published documentation instead of the source tree", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")

    // npm renders this file, so every reference has to resolve for a reader who
    // has only the tarball. A relative `docs/` path does not: `docs/` is not
    // published, and its pages link on into `guides/` and `concepts/` anyway.
    expect(readme).toContain("https://mcp.smithers.sh")
    expect(readme).not.toMatch(/\]\(\.\/docs\//)

    // Nothing is published yet, so the README states that and teaches no install.
    expect(readme).toContain("not published to npm yet")
    expect(readme).not.toContain("pnpm add @smthrs/mcp")

    // The links a reader without the repository can still follow.
    for (const path of [new URL("../LICENSE", import.meta.url)]) {
      expect(existsSync(path)).toBe(true)
    }

    expect(readme.match(/^## .+$/gm)?.at(-1)).toBe("## License")
    expect(readme.trim().split("## License\n").at(-1)?.trim()).toBe("MIT. See [LICENSE](./LICENSE).")
    expect(readme.slice(0, readme.indexOf("## License"))).toContain("`maxStderrBytes` (2048 by default)")
  })

  it.each([
    "../README.md",
    "../docs/guides/connect-a-server.md",
    "../docs/guides/configure-servers-for-the-cli.md"
  ])("separates locked server installation from credentials in %s", (path) => {
    const document = readFileSync(new URL(path, import.meta.url), "utf8")
    expect(document).not.toMatch(/npx(?: -y|["']\s*,)/)

    const installRecipe = (text: string) =>
      [...text.matchAll(/```bash\n([\s\S]*?)```/g)].find((match) =>
        match[1]?.includes("@modelcontextprotocol/server-github")
      )?.[1]
    const recipe = installRecipe(document)
    expect(recipe).toBeDefined()
    expect(recipe).toContain(
      "--package-lock-only --ignore-scripts --save-exact @modelcontextprotocol/server-github@2025.4.8"
    )
    expect(recipe).toContain("npm ci --prefix /path/to/mcp-servers --ignore-scripts")
    const commands = recipe?.split("\n").filter((line) => line.includes("npm ")) ?? []
    expect(commands).toHaveLength(2)
    for (const command of commands) {
      expect(command).toMatch(/^env -u GITHUB_TOKEN -u GITHUB_PERSONAL_ACCESS_TOKEN npm /)
    }
    expect(recipe).toBe(installRecipe(readFileSync(new URL("../README.md", import.meta.url), "utf8")))
    expect(document).toMatch(/command"?: "\/path\/to\/mcp-servers\/node_modules\/\.bin\/mcp-server-github"/)
    expect(document).toMatch(/args"?: \[\]/)
    expect(document).toMatch(
      /env"?: \{ GITHUB_PERSONAL_ACCESS_TOKEN: process\.env\.GITHUB_TOKEN \}|env": \{ "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_\.\.\." \}/
    )
  })

  it("keeps the source tree's docs out of the published tarball", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { readonly files: ReadonlyArray<string> }

    // `docs/*.md` shipped the four top-level pages and none of the `guides/`
    // and `concepts/` pages they link to, so the tarball carried a docs tree
    // whose own links were broken. mcp.smithers.sh is the whole tree.
    expect(manifest.files.some((pattern) => pattern.startsWith("docs/"))).toBe(false)
    expect(manifest.files).toContain("README.md")
  })
})
