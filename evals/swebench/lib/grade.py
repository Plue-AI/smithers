"""Runs the official SWE-bench evaluator against the architecture the rig uses.

    .venv-swb/bin/python lib/grade.py <the evaluator's own arguments>

The evaluator chooses its image architecture from `platform.machine()` alone
(`swebench/harness/test_spec/test_spec.py`: arm64 on an Apple Silicon host
unless the instance is in its `USE_X86` set). Every other part of this rig pins
`linux/amd64`: `run-instance.sh` and `run-instance-codex.sh` pull, extract, and
run `--platform linux/amd64`, so the agent edits an x86_64 checkout and its
patch is written against that tree. Left alone, grading on this host therefore
looks for `sweb.eval.arm64.<instance>`, finds none of the cached x86_64 images,
and tries to build one — which on 2026-08-19 timed out against the docker
socket and reported `django__django-16612` as an error rather than a verdict.

So this is not a thumb on the scale: it makes the grader use the same
architecture the patch was produced on. Nothing else is changed — the
evaluator's own code, dataset, and grading logic run untouched, and the tests
still execute inside the official image.

The override is process-local and lasts only for this invocation.

## SWB_EVAL_EXPORTS — environment the graded tests were always meant to have

    SWB_EVAL_EXPORTS='{"HTTPBIN_URL":"http://192.168.215.7/"}'
    SWB_EVAL_EXPORTS_REPOS='psf/requests'

`SWB_EVAL_EXPORTS` is a JSON object of shell variables to export inside the
instance container, prepended to the official `eval.sh` immediately after its
`set -uxo pipefail` line and before any of the evaluator's own commands.
`SWB_EVAL_EXPORTS_REPOS` narrows that to a comma-separated list of dataset
repos; unset means every instance in this invocation.

There is exactly one caller, and one reason. `psf/requests`' graded tests are
network tests: `test_requests.py` reads `HTTPBIN = os.environ.get('HTTPBIN_URL',
'http://httpbin.org/')` and roughly a third of the dataset's `FAIL_TO_PASS` and
`PASS_TO_PASS` identifiers for `psf__requests-1766` and `psf__requests-2317`
route through it. On 2026-08-21 the public httpbin.org answered 503, so those
tests failed for both harnesses regardless of patch — including 34 and 22
`PASS_TO_PASS` tests, which pass on the unmodified checkout by construction and
so indict the environment rather than the patch. `evaluate.sh` therefore starts
a local httpbin (`lib/httpbin.sh`) and points the suite at it through the
variable the suite already reads.

What this does not do: it never touches the patch, the test identifiers, the
test file, the dataset, the grading logic, or the report. The exports land in
the archived `eval.sh` and in `test_output.txt` under `set -x`, so any grading
that used them says so in its own log. `evaluate.sh` applies them to
`psf/requests` alone, and to whichever harness produced the patch, so the two
arms stay graded under one rig.

## Scoped image cleanup — the defect that produced every `eval error`

The evaluator's post-run `clean_images` (`swebench/harness/docker_utils.py`)
deletes, at `--cache_level env`, **every** `sweb.eval.*` image on the daemon that
was not present when this process started — not only the instance it graded:

    elif image_name.startswith("sweb.eval"):
        if cache_level in {"none", "base", "env"} and (clean or not existed_before):
            return True

This rig runs the benchmark as concurrent per-instance workers. Grading is
serialized by `.grade-lock`, but *pulling* is not, so worker B's `docker pull`
routinely lands inside worker A's evaluator process — after A's `list_images`
snapshot and before A's cleanup. A then deletes B's freshly pulled image, and B
grades against nothing:

    docker.errors.ImageNotFound: 404 ... No such image: sweb.eval.x86_64...

That is verbatim what `fullbench/manifest.jsonl` recorded as `eval error` for
`django__django-12741`, `django__django-13406`, `django__django-15380` and
`matplotlib__matplotlib-22865` in r90, and it reproduced live on
`astropy__astropy-7166` during the 2026-08-21 codex backfill.

So this narrows the cleanup to the instances this invocation was asked to grade,
by adding every other instance's `sweb.eval` image to the "existed before" set.
It removes no image the evaluator would have kept and keeps no image the
evaluator would have removed *for the instances it graded*; it only stops one
grading from deleting another's. `--cache_level` still decides what happens to
this invocation's own images, and nothing about how a patch is graded changes.
"""

import json
import os
import platform
import runpy
import shlex
import sys
import types

_REAL_MACHINE = platform.machine


def _eval_exports() -> dict[str, str]:
    """The exports requested for this invocation, as a name -> value mapping."""
    raw = os.environ.get("SWB_EVAL_EXPORTS", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise SystemExit(f"grade.py: SWB_EVAL_EXPORTS is not valid JSON: {error}")
    if not isinstance(parsed, dict):
        raise SystemExit("grade.py: SWB_EVAL_EXPORTS must be a JSON object")
    exports: dict[str, str] = {}
    for name, value in parsed.items():
        if not isinstance(name, str) or not name.replace("_", "").isalnum():
            raise SystemExit(f"grade.py: SWB_EVAL_EXPORTS name {name!r} is not a shell identifier")
        exports[name] = str(value)
    return exports


def _install_eval_exports() -> None:
    exports = _eval_exports()
    if not exports:
        return
    repos_raw = os.environ.get("SWB_EVAL_EXPORTS_REPOS", "").strip()
    repos = {r.strip() for r in repos_raw.split(",") if r.strip()} or None

    from swebench.harness.test_spec.test_spec import TestSpec

    original = TestSpec.eval_script
    lines = [f"export {name}={shlex.quote(value)}" for name, value in exports.items()]

    def eval_script(self):  # type: ignore[no-untyped-def]
        script = original.fget(self)
        if repos is not None and self.repo not in repos:
            return script
        # The official script is "#!/bin/bash\nset -uxo pipefail\n<commands>".
        # The exports go after the two, so they are in scope for every command
        # the evaluator wrote and are echoed by `set -x` like everything else.
        head, _, tail = script.partition("set -uxo pipefail\n")
        if not _:
            raise SystemExit("grade.py: the evaluator's eval script no longer starts with `set -uxo pipefail`")
        return head + "set -uxo pipefail\n" + "\n".join(lines) + "\n" + tail

    TestSpec.eval_script = property(eval_script)  # type: ignore[assignment]
    scope = "every instance" if repos is None else ", ".join(sorted(repos))
    print(
        f"grade.py: exporting {', '.join(sorted(exports))} inside the eval script for {scope}",
        file=sys.stderr,
    )


def _graded_instance_ids() -> set[str]:
    """The instance ids this invocation was asked to grade.

    Taken from `--instance_ids`, and from the predictions file when that flag is
    absent, because the evaluator accepts either.
    """
    argv = sys.argv[1:]
    ids: set[str] = set()
    if "--instance_ids" in argv:
        for value in argv[argv.index("--instance_ids") + 1 :]:
            if value.startswith("--"):
                break
            ids.add(value)
    if ids:
        return ids
    if "--predictions_path" in argv:
        path = argv[argv.index("--predictions_path") + 1]
        try:
            with open(path, encoding="utf8") as handle:
                ids.update(json.load(handle).keys())
        except (OSError, json.JSONDecodeError, AttributeError):
            return set()
    return ids


def _instance_of(tag: str) -> str:
    """The instance id an official eval image tag names, or "" if it names none.

    `swebench/sweb.eval.x86_64.django_1776_django-12741:latest` ->
    `django__django-12741`. `_1776_` is the evaluator's own escape for `__`
    (`swebench/harness/test_spec/test_spec.py`), because a docker tag may not
    contain two consecutive underscores.
    """
    name = tag.split("/", 1)[-1].split(":", 1)[0]
    if not name.startswith("sweb.eval."):
        return ""
    parts = name.split(".", 3)
    return parts[3].replace("_1776_", "__") if len(parts) > 3 else ""


def _install_scoped_image_cleanup() -> None:
    ids = _graded_instance_ids()
    if not ids:
        # Nothing to scope to. Leaving the evaluator's own behaviour in place is
        # the honest default; silently protecting everything would be a change
        # this file cannot justify.
        print("grade.py: no instance ids on the command line; image cleanup is the evaluator's own", file=sys.stderr)
        return

    # Patched on `docker_utils`, not on `run_evaluation`: `runpy.run_module`
    # below re-executes `run_evaluation` in a fresh namespace, and its
    # `from swebench.harness.docker_utils import clean_images` binds whatever
    # `docker_utils` holds at that moment. A name patched on the already-imported
    # `run_evaluation` module object would be a name the evaluator never reads.
    import swebench.harness.docker_utils as docker_utils
    from swebench.harness.docker_utils import list_images

    original = docker_utils.clean_images

    def clean_images(client, prior_images, cache_level, clean):  # type: ignore[no-untyped-def]
        protected = set(prior_images)
        for tag in list_images(client):
            instance = _instance_of(tag)
            if instance and instance not in ids:
                protected.add(tag)
        kept = len(protected) - len(set(prior_images))
        if kept:
            print(
                f"grade.py: protecting {kept} eval image(s) belonging to instances this grading did not run",
                file=sys.stderr,
            )
        return original(client, protected, cache_level, clean)

    docker_utils.clean_images = clean_images  # type: ignore[assignment]


def _install_plue_transport() -> None:
    """Every container the evaluator starts is a Smithers Cloud workspace.

    `SWB_TRANSPORT=plue` replaces the evaluator's docker calls, and nothing
    else, with `lib/plue.py`'s: `build_container` boots a workspace from the
    same `swebench/sweb.eval.x86_64.*` image with `--network none`, and
    `copy_to_container`, `exec_run_with_timeout` and `cleanup_container`
    reach it through the public CLI. The evaluator's own `run_instance`
    applies the patch with its three commands, runs its `eval.sh`, and grades
    the log with its own parser, so a verdict means what it means locally.
    No image is local, so listing, cleaning and removing images are no-ops and
    the scoped cleanup above has nothing to scope.
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import plue  # noqa: E402  lib/plue.py
    import docker
    import swebench.harness.docker_build as docker_build
    import swebench.harness.docker_utils as docker_utils
    import swebench.harness.reporting as reporting

    no_images = types.SimpleNamespace(images=types.SimpleNamespace(list=lambda **_: []))
    docker.from_env = lambda *_, **__: no_images  # type: ignore[assignment]
    docker_build.build_container = plue.evaluator_container  # type: ignore[assignment]
    docker_utils.copy_to_container = plue.evaluator_copy  # type: ignore[assignment]
    docker_utils.exec_run_with_timeout = plue.evaluator_exec_with_timeout  # type: ignore[assignment]
    docker_utils.cleanup_container = plue.evaluator_cleanup  # type: ignore[assignment]
    docker_utils.remove_image = lambda *_, **__: None  # type: ignore[assignment]
    docker_utils.list_images = lambda *_, **__: set()  # type: ignore[assignment]
    docker_utils.clean_images = lambda *_, **__: None  # type: ignore[assignment]
    report = reporting.make_run_report
    reporting.make_run_report = lambda predictions, dataset, run_id, client=None: report(  # type: ignore[assignment]
        predictions, dataset, run_id, None)
    print("grade.py: SWB_TRANSPORT=plue; every evaluator container is a Smithers Cloud workspace", file=sys.stderr)


def main() -> None:
    # Only the evaluator's image selection reads this; the containers it starts
    # report their own architecture from inside, unaffected.
    platform.machine = lambda: "x86_64"  # type: ignore[assignment]
    if _REAL_MACHINE() not in {"aarch64", "arm64"}:
        # On an x86_64 host the override is a no-op; say so rather than
        # implying a correction happened.
        print(f"grade.py: host is {_REAL_MACHINE()}; x86_64 selection is already native", file=sys.stderr)
    else:
        print(f"grade.py: host is {_REAL_MACHINE()}; selecting x86_64 images to match the rig's --platform linux/amd64", file=sys.stderr)

    _install_eval_exports()
    if os.environ.get("SWB_TRANSPORT", "docker") == "plue":
        _install_plue_transport()
    else:
        _install_scoped_image_cleanup()

    sys.argv[0] = "swebench.harness.run_evaluation"
    runpy.run_module("swebench.harness.run_evaluation", run_name="__main__")


if __name__ == "__main__":
    main()
