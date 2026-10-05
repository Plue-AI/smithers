/**
 * Last successful same-job ancestry for affected CI.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import * as ContainedProcess from "./internal/ContainedProcess.ts"

class BaseUnavailable extends Data.TaggedError("smithers-build/BaseUnavailable")<{ readonly message: string }> {}

/** A verified green base, or undefined when the full gate must run.
 * @category querying
 * @since 1.0.0
 */
export const resolve = async (
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
  transport: typeof fetch = fetch
): Promise<string | undefined> => {
  const git = async (args: ReadonlyArray<string>, authentication?: string): Promise<string> => {
    let output = ""
    const code = await ContainedProcess.run({
      command: "git",
      args,
      cwd: root,
      environment: {
        ...withoutToken(environment),
        // One-command configuration, never persisted in repository Git config.
        ...(authentication === undefined ? {} : {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${
            Buffer.from(`x-access-token:${authentication}`).toString("base64")
          }`
        })
      },
      signal,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      fatalUtf8: true,
      stdout: (text) => {
        output += text
      },
      stderr: () => {}
    })
    if (code !== 0) throw new BaseUnavailable({ message: "green base git discovery failed" })
    return output.trim()
  }
  try {
    if (environment.GITHUB_EVENT_NAME === "pull_request") {
      return await git(["rev-parse", "--verify", "--end-of-options", "HEAD^1^{commit}"])
    }
    if (environment.GITHUB_EVENT_NAME !== "push") return undefined
    const {
      GITHUB_REPOSITORY: repo,
      GITHUB_JOB: job,
      GITHUB_REF_NAME: branch,
      GITHUB_WORKFLOW_REF: workflowRef,
      GITHUB_TOKEN: token,
      GITHUB_RUN_NUMBER: number
    } = environment
    const runNumber = Number(number)
    const jobName = environment.SMTHRS_CI_JOB ?? job
    if (!repo || !job || !branch || !workflowRef || !token || !Number.isSafeInteger(runNumber) || runNumber < 1) {
      return undefined
    }
    const workflow = workflowRef.slice(workflowRef.indexOf("/.github/workflows/") + 1).split("@")[0]!.split("/").pop()!
    if (!workflowRef.includes("/.github/workflows/") || !/^[\w.-]+\.ya?ml$/.test(workflow)) return undefined
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return undefined
    const api = new URL(environment.GITHUB_API_URL ?? "https://api.github.com")
    if (
      api.origin !== "https://api.github.com" || api.username !== "" || api.password !== "" ||
      api.pathname !== "/" || api.search !== "" || api.hash !== ""
    ) return undefined
    const get = async (path: string): Promise<unknown> => {
      const url = new URL(`${api.pathname.replace(/\/$/, "")}/repos/${repo}/${path}`, api.origin)
      // Never follow a redirect with the token, even to the same host.
      const response = await transport(url, {
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        signal: signal === undefined
          ? AbortSignal.timeout(10_000)
          : AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      })
      if (!response.ok) throw new BaseUnavailable({ message: "green base API unavailable" })
      return response.json()
    }
    const head = await git(["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"])
    // Bound discovery; an older base beyond this window falls back to the full gate.
    for (let page = 1; page <= 5; page++) {
      const data = await get(
        `actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${
          encodeURIComponent(branch)
        }&status=completed&per_page=100&page=${page}`
      ) as { workflow_runs: Array<{ id: number; run_number: number; head_branch: string; head_sha: string }> }
      if (!Array.isArray(data.workflow_runs)) return undefined
      const runs = data.workflow_runs.filter((run) => run.run_number < runNumber && run.head_branch === branch)
        .sort((a, b) => b.run_number - a.run_number)
      for (const run of runs) {
        if (!Number.isSafeInteger(run.id) || run.id < 1) return undefined
        const jobs = await get(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`) as {
          total_count?: number
          jobs: Array<{ name: string; conclusion: string }>
        }
        if (!Array.isArray(jobs.jobs)) return undefined
        // A truncated job list cannot establish which job passed.
        if ((jobs.total_count ?? jobs.jobs.length) > jobs.jobs.length) return undefined
        const matching = jobs.jobs.filter((entry) => entry.name === jobName)
        if (matching.length !== 1 || matching[0]!.conclusion !== "success") continue
        if (typeof run.head_sha !== "string" || !/^[a-fA-F0-9]{40}$/.test(run.head_sha) || run.head_sha === head) {
          return undefined
        }
        const comparison = await get(`compare/${run.head_sha}...${head}`) as {
          status: string
          merge_base_commit?: { sha: string }
        }
        if (comparison.status !== "ahead" || comparison.merge_base_commit?.sha !== run.head_sha) return undefined
        await git(["fetch", "--depth=1", "--no-tags", "origin", run.head_sha], token)
        // Both the API and the local object must establish the ancestry and tree diff.
        // Shallow fetches need not connect the graph locally; compare supplies ancestry.
        await git(["rev-parse", "--verify", "--end-of-options", `${run.head_sha}^{commit}`])
        return run.head_sha
      }
      if (data.workflow_runs.length < 100) break
    }
    return undefined
  } catch (cause) {
    if (signal?.aborted) throw cause
    return undefined
  }
}

/** Removes the API credential before graph loading or execution.
 * @category security
 * @since 1.0.0
 */
export const withoutToken = (
  environment: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> => {
  const { GITHUB_TOKEN: _token, ...rest } = environment
  return rest
}
