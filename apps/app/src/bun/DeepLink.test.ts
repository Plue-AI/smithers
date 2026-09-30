import { describe, expect, test } from "bun:test"
import { deepLinkPath } from "./DeepLink"

describe("deepLinkPath", () => {
  test("smithers://open/<owner>/<repo> opens that repository page", () => {
    expect(deepLinkPath("smithers://open/smithersai/smithers")).toBe("/smithersai/smithers")
    expect(deepLinkPath("smithers://open/Some-Owner/repo_name.js")).toBe("/Some-Owner/repo_name.js")
  })

  test("every other shape is refused", () => {
    for (const url of [
      "",
      "not a url",
      "smithers://x",
      "smithers://open",
      "smithers://open/",
      "smithers://open/owner",
      "smithers://open/owner/",
      "smithers://open/owner/repo/",
      "smithers://open/owner/repo/extra",
      "smithers://open//repo",
      "smithers://open/owner/repo?next=/evil",
      "smithers://open/owner/repo?",
      "smithers://open/owner/repo#frag",
      "smithers://open/owner/repo#",
      "smithers://user:pass@open/owner/repo",
      "smithers://open:8080/owner/repo",
      "smithers://open/owner%2Fx/repo",
      "smithers://open/../repo",
      "smithers://open/owner/..",
      "smithers://open/./repo",
      "smithers://open/own er/repo",
      "smithers://open/api/user",
      "smithers://open/API/user",
      "smithers://run/owner/repo",
      "smithers:open/owner/repo",
      "https://open/owner/repo",
      "javascript:alert(1)",
      "file:///etc/passwd"
    ]) expect({ url, path: deepLinkPath(url) }).toEqual({ url, path: null })
  })

  test.each([
    { url: "SMITHERS://open/Some-Owner/Repo", path: "/Some-Owner/Repo" },
    { url: "SmItHeRs://open/Some-Owner/Repo", path: "/Some-Owner/Repo" },
    { url: "smithers://open/owner_2/repo-3.4", path: "/owner_2/repo-3.4" },
    { url: "smithers://open/a/b", path: "/a/b" },
    { url: "smithers://open/owner/repo.git", path: "/owner/repo.git" }
  ])("$url preserves the repository spelling in its literal renderer path", ({ url, path }) => {
    expect(deepLinkPath(url)).toBe(path)
  })

  // The producer (smthrs open) and renderer repository grammar use ASCII
  // word characters, dots, and hyphens. URL encoding cannot add Unicode names.
  test.each([
    { url: "smithers://open/café/repo" },
    { url: "smithers://open/owner/café" },
    { url: "smithers://open/cafe\u0301/repo" },
    { url: "smithers://open/owner/cafe\u0301" },
    { url: "smithers://open/𐐀/repo" },
    { url: "smithers://open/owner/𐐀" },
    { url: "smithers://open/中文/repo" },
    { url: "smithers://open/owner/中文" },
    { url: "smithers://open/caf%C3%A9/repo" }
  ])("$url cannot name a repository outside the shared segment grammar", ({ url }) => {
    expect(deepLinkPath(url)).toBeNull()
  })

  test.each([
    { url: "smithers://user@open/owner/repo" },
    { url: "smithers://:password@open/owner/repo" },
    { url: "smithers://open:0/owner/repo" },
    { url: "smithers://open:abc/owner/repo" },
    { url: "smithers://[broken/owner/repo" },
    { url: "smithers:///owner/repo" },
    { url: "smithers://open/owner/repo.name?" },
    { url: "smithers://open/owner/repo.name#" },
    { url: "smithers://open/aPi/repo" }
  ])("$url is refused without throwing or returning a renderer route", ({ url }) => {
    expect(deepLinkPath(url)).toBeNull()
  })
})
