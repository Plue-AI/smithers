/**
 * Targets for the Harbor and Pier benchmark adapter.
 *
 * The offline fixture gates CI after the workspace install. Docker, a model
 * seat and a Harbor or Pier install remain documented operator commands: a
 * gate that needs a funded seat and a warm docker cache cannot hold a tree.
 */
import { Smithers } from "@smthrs/targets"

const offline = Smithers.Shell.Test({
  summary: "Check the Harbor adapter's prompt, environment, journal fold and trajectory without docker or a model.",
  script: Smithers.file("verify.sh"),
  data: [
    Smithers.glob("//evals/harbor/*.{py,md,sh}"),
    Smithers.glob("//evals/harbor/fixtures/**")
  ],
  timeout: "5m"
})

const securityReview = Smithers.SecurityReview({
  cwd: "evals/harbor",
  include: ["*.py", "*.sh", "prompt.md", "fixtures/**"],
  checks: [
    {
      id: "task-copy-stays-in-environment-dir",
      title: "Dockerfile COPY sources resolve inside the task's environment directory",
      threat: "A malicious benchmark task uploads the operator's host files (Codex auth.json, SMITHERS_TOKEN config) into a workspace the model controls.",
      lookFor: [
        "`Path(self.environment_dir) / src` in _plue_start with src taken from a task Dockerfile COPY line and no resolve()+prefix check against environment_dir.",
        "An absolute COPY source (`/home/...`) or `..` segments accepted by _COPY_RE and parse_trivial_dockerfile.",
        "A symlink inside the environment directory followed by `workspace cp` to a host path outside it."
      ],
      paths: ["plue_env.py"]
    },
    {
      id: "task-dockerfile-shell-injection",
      title: "Task Dockerfile and task.toml values reach guest shells only as quoted data",
      threat: "A malicious task runs arbitrary root commands in the workspace before the trial starts, or tampers with grading.",
      lookFor: [
        "`chmod {mode_bits} {target}` built from a RUN chmod line without shlex.quote on either field.",
        "Workdir, cwd, env keys or COPY destinations from the task interpolated into a guest command string rather than passed as separate CLI arguments.",
        "Harbor exec env values merged into `--env KEY=VALUE` without rejecting a key containing `=` or a newline."
      ],
      paths: ["plue_env.py", "plue_docker.py"]
    },
    {
      id: "operator-token-confinement",
      title: "SMITHERS_TOKEN and Codex auth.json never reach the task container, logs or the model",
      threat: "A model under test or anyone reading published trial logs obtains the operator's plue token or ChatGPT subscription credentials.",
      lookFor: [
        "plue-docker.json written with a mode other than 0600, or the shim directory placed under logs_dir or the kept workspace.",
        "The full host os.environ passed by cli_environment to the CLI while the bash flow can run a host command without SMITHERS_BASH_CONTAINER set.",
        "smithers-run.json, codex-account.json, requeue.log or trajectory.json recording an email, token, auth.json content or the CLI env.",
        "logger.debug of the full plue argv, which carries `--env KEY=VALUE` pairs, at a level that reaches Harbor's job logs.",
        "PooledCodex uploading auth.json into the container and not deleting it before the verifier or trajectory download runs.",
        "plue_docker.translate copying a bare `-e KEY` from the host environ (SMITHERS_TOKEN, OPENAI_API_KEY) into a guest `--env` pair without an allowlist."
      ],
      paths: ["smithers_agent.py", "plue_docker.py", "plue_env.py", "codex_pool.py", "accounts.py"]
    },
    {
      id: "prompt-template-injection",
      title: "The task instruction is inserted into flow.mdx as inert text",
      threat: "A malicious task instruction rewrites the flow's frontmatter (model, flows, effort) or evaluates MDX expressions on the harness host.",
      lookFor: [
        "render_prompt replacing {{instruction}} into flow.mdx without escaping `{`, `<`, or a leading `---` that the MDX loader would parse.",
        "A replacement order in render_prompt that lets a substituted value introduce a later placeholder (for example {{commit}} or {{container}}).",
        "prompt.md granting any flow beyond `bash` or omitting the container seal."
      ],
      paths: ["smithers_agent.py", "prompt.md"]
    },
    {
      id: "container-seal-and-host-audit",
      title: "The agent's commands run only in the task container and host calls are detected",
      threat: "The model under test reads tests/ or solution/ on the harness host and reward-hacks a benchmark score.",
      lookFor: [
        "A run path where SMITHERS_BASH_CONTAINER is unset or names a container other than the trial's.",
        "container_of trusting SMITHERS_BENCH_CONTAINER or a docker ps result that could match another trial's compose project.",
        "audit_host_calls.py classifying a host call as benign when its command or cwd names tests/, solution/ or the dataset cache through a variable or relative path.",
        "The plue docker shim accepting a docker verb other than exec, or an exec flag it passes through unparsed."
      ],
      paths: ["smithers_agent.py", "audit_host_calls.py", "plue_docker.py", "codex_pool.py"]
    },
    {
      id: "registry-fetch-ssrf",
      title: "Image config fetches reach only the image's registry over HTTPS",
      threat: "A task FROM line or a hostile registry makes the harness host request internal URLs or local files.",
      lookFor: [
        "urlopen of the WWW-Authenticate realm without requiring an https scheme (urllib also opens file:// and http://).",
        "A registry host parsed from the FROM reference (localhost, 169.254.169.254, a private IP) fetched without an allowlist.",
        "A cached image config keyed by a mutable tag and trusted as if digest-pinned."
      ],
      paths: ["image_config.py"]
    },
    {
      id: "workspace-reap-scope",
      title: "Cleanup deletes only workspaces this job created",
      threat: "An operator running requeue.py deletes another concurrent job's or user's workspaces in PLUE_REPO.",
      lookFor: [
        "reap matching workspace names with startswith(prefix) and no separator, so trial `x-1` also matches `x-10`.",
        "reap_dead deleting every `-env` or `-verifier-*` workspace in the repo regardless of which job created it.",
        "keep_retried_attempts or requeue moving a directory chosen from untrusted trial names outside `<job>.infra`."
      ],
      paths: ["requeue.py", "plue_env.py"]
    },
    {
      id: "score-classification-integrity",
      title: "Only real infrastructure faults turn a failed trial into a re-run",
      threat: "A model under test prints a fake SSH or gateway error so its failed trial is classified infra and re-run, inflating the published score.",
      lookFor: [
        "outcome.classify matching _TRANSPORT against exception_message text the agent's own output can write.",
        "health.py or requeue.py trusting result.json or smithers-run.json fields from inside the trial directory to pick trials to discard or re-run.",
        "audit_host_calls.py reading container or command fields from trial files the agent can write."
      ],
      paths: ["outcome.py", "health.py", "requeue.py", "audit_host_calls.py"]
    },
    {
      id: "shared-state-files",
      title: "Pool and slot ledger state files cannot be abused by another local user",
      threat: "Another user on the harness host redirects account leases or corrupts the slot ledger to stall or misattribute trials.",
      lookFor: [
        "pool.json, plue-slots.json or plue-leaks.log created world-writable or under a shared /tmp path.",
        "A lock file opened by path without O_NOFOLLOW where the directory is writable by others."
      ],
      paths: ["accounts.py", "plue_env.py"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { offline, ...securityReview }
})
