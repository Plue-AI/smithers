"""Offline subprocess checks for Harbor workspace ownership and cleanup."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARBOR = HERE.parent
sys.path.insert(0, str(HARBOR))


def invoke(code: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, "-c", code], cwd=HARBOR, env=env,
                          capture_output=True, text=True, timeout=20)


def check_unrelated_dead_workspace_survives() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        state = root / "state.json"
        ledger = root / "ledger.json"
        cli = root / "smithers"
        state.write_text(json.dumps({"rows": [
            {"id": "foreign", "name": "trial-one-env", "status": "failed"}], "calls": []}))
        cli.write_text("#!/usr/bin/env python3\n"
                       "import json, os, sys\n"
                       "from pathlib import Path\n"
                       "p = Path(os.environ['TEST_CLI_STATE'])\n"
                       "state = json.loads(p.read_text())\n"
                       "args = sys.argv[1:]\n"
                       "state['calls'].append(args)\n"
                       "p.write_text(json.dumps(state))\n"
                       "if args[:2] == ['workspace', 'list']:\n"
                       "    print(json.dumps(state['rows']))\n"
                       "elif args[:2] == ['workspace', 'delete']:\n"
                       "    print('{}')\n"
                       "else:\n"
                       "    sys.exit(2)\n")
        cli.chmod(0o755)
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(ledger), "TEST_CLI_STATE": str(state)}
        result = invoke("import requeue; requeue.reap_dead()", env)
        assert result.returncode == 0, result.stderr
        calls = json.loads(state.read_text())["calls"]
        assert not any(call[:2] == ["workspace", "delete"] for call in calls), calls


def check_recorded_cleanup() -> None:
    import workspace_ownership

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        state = root / "state.json"
        cli = root / "smithers"
        cli.write_text("#!/usr/bin/env python3\n"
                       "import json, os, sys\n"
                       "from pathlib import Path\n"
                       "p = Path(os.environ['TEST_CLI_STATE'])\n"
                       "s = json.loads(p.read_text()); a = sys.argv[1:]; s['calls'].append(a)\n"
                       "if a[:2] == ['workspace', 'view']:\n"
                       "    print(json.dumps(next(r for r in s['rows'] if r['id'] == a[2])))\n"
                       "elif a[:2] == ['workspace', 'delete']:\n"
                       "    if a[2] in s['fail']:\n"
                       "        p.write_text(json.dumps(s)); print('{\"error\":{\"message\":\"delete failed\"}}'); sys.exit(1)\n"
                       "    s['rows'] = [r for r in s['rows'] if r['id'] != a[2]]; print('{}')\n"
                       "else: sys.exit(2)\n"
                       "p.write_text(json.dumps(s))\n")
        cli.chmod(0o755)
        state.write_text(json.dumps({"rows": [
            {"id": "owned-env", "name": "anything", "status": "running"},
            {"id": "owned-verifier", "name": "also-anything", "status": "running"},
            {"id": "failed-delete", "name": "failure", "status": "running"},
            {"id": "unowned", "name": "trial-one-env", "status": "failed"},
            {"id": "other-session", "name": "other", "status": "running"},
            {"id": "other-repo", "name": "other-repo", "status": "running"},
        ], "calls": [], "fail": ["failed-delete"]}))
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"), "TEST_CLI_STATE": str(state)}
        previous = os.environ.get("PLUE_WORKSPACE_LEDGER")
        os.environ["PLUE_WORKSPACE_LEDGER"] = env["PLUE_WORKSPACE_LEDGER"]
        try:
            for repo, session, ident in [
                ("acme/bench", "trial__one__env", "owned-env"),
                ("acme/bench", "trial__one__verifier__trial", "owned-verifier"),
                ("acme/bench", "trial__one__env", "failed-delete"),
                ("acme/bench", "trial__one2__env", "other-session"),
                ("other/bench", "other__trial__env", "other-repo"),
            ]:
                workspace_ownership.record(repo, session, ident)
            job = root / "job"
            trial = job / "trial__one"
            trial.mkdir(parents=True)
            (trial / "result.json").write_text("{}")
            command = [sys.executable, str(HARBOR / "requeue.py"), str(job)]
            result = subprocess.run(command, env=env, capture_output=True, text=True, check=False)
            assert result.returncode != 0 and "failed-delete" in result.stderr, result.stderr
            assert trial.is_dir(), "failed cleanup must leave the attempt available for retry"
            calls = json.loads(state.read_text())["calls"]
            deletes = [call[2] for call in calls if call[:2] == ["workspace", "delete"]]
            assert set(deletes) == {"owned-env", "owned-verifier", "failed-delete"}, deletes
            assert {row["id"] for row in workspace_ownership.records()} == {
                "failed-delete", "other-session", "other-repo"}
            saved = json.loads(state.read_text())
            saved["fail"] = []
            state.write_text(json.dumps(saved))
            retry = subprocess.run(command, env=env, capture_output=True, text=True, check=False)
            assert retry.returncode == 0, retry.stderr
            assert not trial.exists() and (root / "job.infra/trial__one/result.json").is_file()
            assert {row["id"] for row in workspace_ownership.records()} == {"other-session", "other-repo"}
        finally:
            if previous is None:
                os.environ.pop("PLUE_WORKSPACE_LEDGER", None)
            else:
                os.environ["PLUE_WORKSPACE_LEDGER"] = previous


def check_dead_cleanup() -> None:
    import workspace_ownership

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        state = root / "state.json"
        cli = root / "smithers"
        cli.write_text("#!/usr/bin/env python3\n"
                       "import json, os, sys\n"
                       "from pathlib import Path\n"
                       "p = Path(os.environ['TEST_CLI_STATE']); s = json.loads(p.read_text()); a = sys.argv[1:]\n"
                       "s['calls'].append(a)\n"
                       "if a[:2] == ['workspace', 'view']:\n"
                       "    print(json.dumps(next(r for r in s['rows'] if r['id'] == a[2])))\n"
                       "elif a[:2] == ['workspace', 'delete']: print('{}')\n"
                       "else: sys.exit(2)\n"
                       "p.write_text(json.dumps(s))\n")
        cli.chmod(0o755)
        state.write_text(json.dumps({"rows": [
            {"id": "failed", "name": "arbitrary", "status": "failed"},
            {"id": "suspended", "name": "different", "status": "suspended"},
            {"id": "running", "name": "running", "status": "running"},
            {"id": "unowned", "name": "trial-one-env", "status": "failed"},
        ], "calls": []}))
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"), "TEST_CLI_STATE": str(state)}
        previous = os.environ.get("PLUE_WORKSPACE_LEDGER")
        os.environ["PLUE_WORKSPACE_LEDGER"] = env["PLUE_WORKSPACE_LEDGER"]
        try:
            for ident in ("failed", "suspended", "running"):
                workspace_ownership.record("acme/bench", "trial__one__env", ident)
            result = invoke("import requeue; requeue.reap_dead()", env)
            assert result.returncode == 0, result.stderr
            calls = json.loads(state.read_text())["calls"]
            deletes = [call[2] for call in calls if call[:2] == ["workspace", "delete"]]
            assert set(deletes) == {"failed", "suspended"}, deletes
            assert {call[2] for call in calls if call[:2] == ["workspace", "view"]} == {
                "failed", "suspended", "running"}, calls
            assert not any(call[:2] == ["workspace", "list"] for call in calls), calls
            assert {row["id"] for row in workspace_ownership.records()} == {"running"}
        finally:
            if previous is None:
                os.environ.pop("PLUE_WORKSPACE_LEDGER", None)
            else:
                os.environ["PLUE_WORKSPACE_LEDGER"] = previous


def check_partial_start_keeps_id_for_recovery() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        state = root / "state.json"
        cli = root / "smithers"
        cli.write_text("#!/usr/bin/env python3\n"
                       "import json, os, sys\n"
                       "from pathlib import Path\n"
                       "p = Path(os.environ['TEST_CLI_STATE']); s = json.loads(p.read_text()); a = sys.argv[1:]\n"
                       "s['calls'].append(a)\n"
                       "if a[:2] == ['workspace', 'create']:\n"
                       "    s['rows'] = [{'id':'boot-id','name':'arbitrary','status':'starting'}]\n"
                       "    print(json.dumps(s['rows'][0]))\n"
                       "elif a[:2] == ['workspace', 'view']:\n"
                       "    assert a[2] == 'boot-id', a\n"
                       "    s['rows'][0]['status'] = 'failed'; print(json.dumps(s['rows'][0]))\n"
                       "elif a[:2] == ['workspace', 'delete']: print('{}')\n"
                       "else: sys.exit(2)\n"
                       "p.write_text(json.dumps(s))\n")
        cli.chmod(0o755)
        state.write_text(json.dumps({"rows": [], "calls": []}))
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"), "TEST_CLI_STATE": str(state),
               "PLUE_WAIT_SEC": "10"}
        start = invoke("import asyncio, logging, types, plue_env; "
                       "o=plue_env._PlueOps(); o.logger=logging.getLogger('test'); "
                       "o.session_id='trial__one__env'; o.task_env_config=types.SimpleNamespace(); "
                       "o._plue_image='image'; o._plue_network=lambda: ('none', []); "
                       "asyncio.run(o._plue_create())", env)
        assert start.returncode != 0 and "is failed" in start.stderr, start.stderr
        calls = json.loads(state.read_text())["calls"]
        assert calls[0][:2] == ["workspace", "create"] and "--wait" not in calls[0], calls
        assert any(call[:3] == ["workspace", "view", "boot-id"] for call in calls), calls
        assert not any(call[:2] == ["workspace", "list"] for call in calls), calls
        receipt = invoke("import json, workspace_ownership; print(json.dumps(workspace_ownership.records()))", env)
        assert receipt.returncode == 0, receipt.stderr
        assert json.loads(receipt.stdout) == [{"repo": "acme/bench", "session": "trial__one__env", "id": "boot-id"}]
        cleanup = invoke("import requeue; requeue.reap(['trial__one'])", env)
        assert cleanup.returncode == 0, cleanup.stderr
        calls = json.loads(state.read_text())["calls"]
        assert [call[2] for call in calls if call[:2] == ["workspace", "delete"]] == ["boot-id"]


def check_wrong_repo_refuses_selected_receipts() -> None:
    import workspace_ownership
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        cli = root / "smithers"
        cli.write_text("#!/bin/sh\nexit 2\n")
        cli.chmod(0o755)
        env = {**os.environ, "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"),
               "SMITHERS_CLI": str(cli), "PLUE_REPO": "wrong/repo"}
        previous = os.environ.get("PLUE_WORKSPACE_LEDGER")
        os.environ["PLUE_WORKSPACE_LEDGER"] = env["PLUE_WORKSPACE_LEDGER"]
        try:
            workspace_ownership.record("acme/bench", "trial__one__env", "owned-id")
            result = invoke("import requeue; requeue.reap(['trial__one'])", env)
            assert result.returncode != 0 and "repo" in result.stderr.lower(), result.stderr
            assert workspace_ownership.records() == [{"repo": "acme/bench", "session": "trial__one__env", "id": "owned-id"}]
        finally:
            if previous is None:
                os.environ.pop("PLUE_WORKSPACE_LEDGER", None)
            else:
                os.environ["PLUE_WORKSPACE_LEDGER"] = previous


def check_missing_create_id_logs_ambiguous_resource() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        cli = root / "smithers"
        cli.write_text("#!/bin/sh\nprintf '%s' '{\"status\":\"starting\"}'\n")
        cli.chmod(0o755)
        leak_log = root / "leaks.log"
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"), "PLUE_LEAK_LOG": str(leak_log)}
        result = invoke("import asyncio, logging, types, plue_env; "
                        "o=plue_env._PlueOps(); o.logger=logging.getLogger('test'); "
                        "o.session_id='trial__one__env'; o.task_env_config=types.SimpleNamespace(cpus=2); "
                        "o._plue_image='image'; o._plue_network=lambda: ('none', []); "
                        "o._plue_reserved=False; o._plue_ledger=lambda: None; "
                        "o._plue_heir=lambda: (_ for _ in ()).throw(AssertionError('failed boot cannot hand off')); "
                        "asyncio.run(o._plue_reserve())", env)
        assert result.returncode != 0 and "no id" in result.stderr, result.stderr
        assert leak_log.is_file(), "ambiguous create must leave an operator receipt"
        assert "trial__one__env" in leak_log.read_text()


def check_async_capacity_failure_retries_after_owned_delete() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        state = root / "state.json"
        cli = root / "smithers"
        cli.write_text("#!/usr/bin/env python3\n"
                       "import json, os, sys\n"
                       "from pathlib import Path\n"
                       "p=Path(os.environ['TEST_CLI_STATE']); s=json.loads(p.read_text()); a=sys.argv[1:]\n"
                       "s['calls'].append(a)\n"
                       "if a[:2] == ['workspace', 'create']:\n"
                       "    s['creates'] += 1; n=s['creates']\n"
                       "    print(json.dumps({'id':f'owned-{n}','status':'starting' if n == 1 else 'running'}))\n"
                       "elif a[:2] == ['workspace', 'view']:\n"
                       "    assert a[2] == 'owned-1', a\n"
                       "    print(json.dumps({'id':'owned-1','status':'failed','failure_code':'no_capacity',"
                       "'failure_message':'no capacity'}))\n"
                       "elif a[:2] == ['workspace', 'delete']: print('{}')\n"
                       "else: sys.exit(2)\n"
                       "p.write_text(json.dumps(s))\n")
        cli.chmod(0o755)
        state.write_text(json.dumps({"calls": [], "creates": 0}))
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"), "TEST_CLI_STATE": str(state),
               "PLUE_WAIT_SEC": "10", "PLUE_CAPACITY_WAIT_SEC": "10"}
        result = invoke("import asyncio, logging, types, plue_env; "
                        "plue_env._CAPACITY_POLL_SEC=0; "
                        "o=plue_env._PlueOps(); o.logger=logging.getLogger('test'); "
                        "o.session_id='trial__one__env'; o.task_env_config=types.SimpleNamespace(); "
                        "o._plue_image='image'; o._plue_network=lambda: ('none', []); "
                        "asyncio.run(o._plue_create()); assert o._workspace_id == 'owned-2'", env)
        assert result.returncode == 0, result.stderr
        calls = json.loads(state.read_text())["calls"]
        assert [call[:2] for call in calls].count(["workspace", "create"]) == 2, calls
        assert [call[2] for call in calls if call[:2] == ["workspace", "delete"]] == ["owned-1"], calls
        receipt = invoke("import json, workspace_ownership; print(json.dumps(workspace_ownership.records()))", env)
        assert receipt.returncode == 0, receipt.stderr
        assert json.loads(receipt.stdout) == [{"repo": "acme/bench", "session": "trial__one__env", "id": "owned-2"}]


def check_delete_not_found_releases_receipt() -> None:
    import workspace_ownership
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        cli = root / "smithers"
        calls = root / "calls"
        cli.write_text("#!/usr/bin/env python3\n"
                       "import json, os, sys\n"
                       "from pathlib import Path\n"
                       "a=sys.argv[1:]; p=Path(os.environ['TEST_CLI_CALLS'])\n"
                       "p.write_text(p.read_text()+json.dumps(a)+'\\n' if p.exists() else json.dumps(a)+'\\n')\n"
                       "if a[:3] == ['workspace','delete','gone']:\n"
                       "    print(json.dumps({'error':{'code':'command_failed','message':"
                       "'DELETE /workspaces/gone -> 404: workspace not found'}}))\n"
                       "    sys.exit(1)\n"
                       "sys.exit(2)\n")
        cli.chmod(0o755)
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"), "TEST_CLI_CALLS": str(calls)}
        previous = os.environ.get("PLUE_WORKSPACE_LEDGER")
        os.environ["PLUE_WORKSPACE_LEDGER"] = env["PLUE_WORKSPACE_LEDGER"]
        try:
            workspace_ownership.record("acme/bench", "trial__one__env", "gone")
            result = invoke("import requeue; assert requeue.reap(['trial__one']) == ['gone']", env)
            assert result.returncode == 0, result.stderr
            assert workspace_ownership.records() == []
            assert [json.loads(line)[:3] for line in calls.read_text().splitlines()] == [
                ["workspace", "delete", "gone"]]
        finally:
            if previous is None:
                os.environ.pop("PLUE_WORKSPACE_LEDGER", None)
            else:
                os.environ["PLUE_WORKSPACE_LEDGER"] = previous


def check_reserve_reclaims_failed_boot() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        state = root / "state.json"
        cli = root / "smithers"
        cli.write_text("#!/usr/bin/env python3\n"
                       "import json, os, sys\n"
                       "from pathlib import Path\n"
                       "p=Path(os.environ['TEST_CLI_STATE']); s=json.loads(p.read_text()); a=sys.argv[1:]\n"
                       "s['calls'].append(a)\n"
                       "if a[:2] == ['workspace','create']:\n"
                       "    print(json.dumps({'id':'failed-boot','status':'starting'}))\n"
                       "elif a[:3] == ['workspace','view','failed-boot']:\n"
                       "    print(json.dumps({'id':'failed-boot','status':'failed',"
                       "'failure_code':'image_pull_failed'}))\n"
                       "elif a[:3] == ['workspace','delete','failed-boot']: print('{}')\n"
                       "else: sys.exit(2)\n"
                       "p.write_text(json.dumps(s))\n")
        cli.chmod(0o755)
        state.write_text(json.dumps({"calls": []}))
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(root / "ledger.json"), "TEST_CLI_STATE": str(state),
               "PLUE_WAIT_SEC": "10"}
        result = invoke("import asyncio, logging, types, plue_env; "
                        "o=plue_env._PlueOps(); o.logger=logging.getLogger('test'); "
                        "o.session_id='trial__one__env'; o.task_env_config=types.SimpleNamespace(cpus=2); "
                        "o._plue_image='image'; o._plue_network=lambda: ('none', []); "
                        "o._plue_reserved=False; o._plue_ledger=lambda: None; "
                        "asyncio.run(o._plue_reserve())", env)
        assert result.returncode != 0 and "failed" in result.stderr, result.stderr
        calls = json.loads(state.read_text())["calls"]
        assert [call[2] for call in calls if call[:2] == ["workspace", "delete"]] == ["failed-boot"], calls
        receipt = invoke("import json, workspace_ownership; print(json.dumps(workspace_ownership.records()))", env)
        assert receipt.returncode == 0 and json.loads(receipt.stdout) == [], receipt.stderr


def check_corrupt_ledger_prevents_create() -> None:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        ledger = root / "ledger.json"
        ledger.write_text("not json")
        cli = root / "smithers"
        marker = root / "called"
        cli.write_text("#!/bin/sh\ntouch \"$TEST_CLI_MARKER\"\nprintf '%s' '{\"id\":\"unexpected\"}'\n")
        cli.chmod(0o755)
        env = {**os.environ, "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/bench",
               "PLUE_WORKSPACE_LEDGER": str(ledger), "TEST_CLI_MARKER": str(marker)}
        result = invoke("import asyncio, logging, types, plue_env; "
                        "o=plue_env._PlueOps(); o.logger=logging.getLogger('test'); "
                        "o.session_id='trial__one__env'; o.task_env_config=types.SimpleNamespace(); "
                        "o._plue_image='image'; o._plue_network=lambda: ('none', []); "
                        "asyncio.run(o._plue_create())", env)
        assert result.returncode != 0 and "ownership ledger" in result.stderr, result.stderr
        assert not marker.exists(), "invalid ownership state must stop before create"


if __name__ == "__main__":
    check_unrelated_dead_workspace_survives()
    check_recorded_cleanup()
    check_dead_cleanup()
    check_partial_start_keeps_id_for_recovery()
    check_wrong_repo_refuses_selected_receipts()
    check_missing_create_id_logs_ambiguous_resource()
    check_async_capacity_failure_retries_after_owned_delete()
    check_delete_not_found_releases_receipt()
    check_reserve_reclaims_failed_boot()
    check_corrupt_ledger_prevents_create()
    print("check_ownership.py: recorded ownership, failed delete retention, dead cleanup")
