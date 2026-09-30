"""Offline TB4 8-vCPU request preservation at the public workspace CLI.

The fake CLI captures command construction only; its running response is not
evidence of a real allocation. Ownership receipts stay in temporary storage.
Run with: python3 -B evals/harbor/fixtures/check_tb4_resources.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import plue_env  # noqa: E402
import workspace_ownership  # noqa: E402

try:
    from harbor.models.task.config import EnvironmentConfig
    from harbor.models.trial.paths import TrialPaths
except ImportError:
    EnvironmentConfig = TrialPaths = None


def check_tb4_8_vcpu_request_preservation() -> None:
    """Limits 8/16 preserve TB4 resources; limit 7 refuses before allocation."""
    for limit in (8, 16, 7):
        with tempfile.TemporaryDirectory(prefix="tb4-resources-") as directory:
            root = Path(directory)
            calls = root / "calls.json"
            ledger = root / "ownership.json"
            cli = root / "smithers"
            cli.write_text(
                f"#!{sys.executable}\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "p = Path(os.environ['TEST_TB4_CLI_CALLS'])\n"
                "calls = json.loads(p.read_text()) if p.exists() else []\n"
                "calls.append(sys.argv[1:]); p.write_text(json.dumps(calls))\n"
                "if sys.argv[1:3] != ['workspace', 'create']: sys.exit(2)\n"
                "print(json.dumps({'id': 'tb4-workspace', 'status': 'running'}))\n"
            )
            cli.chmod(0o700)
            env = {
                "SMITHERS_CLI": str(cli), "PLUE_REPO": "acme/tb4",
                "PLUE_MAX_CPUS": str(limit), "PLUE_MAX_STORAGE_MB": "51200",
                "PLUE_SLOTS": "0", "PLUE_WORKSPACE_LEDGER": str(ledger),
                "TEST_TB4_CLI_CALLS": str(calls),
            }
            with patch.dict(os.environ, env, clear=True):
                if EnvironmentConfig is not None:
                    environment = root / "environment"
                    environment.mkdir()
                    ops = plue_env.PlueEnvironment(
                        environment_dir=environment, environment_name="tb4-eight-cpu",
                        session_id="tb4__eight_cpu__env",
                        trial_paths=TrialPaths(root / "trial"),
                        task_env_config=EnvironmentConfig(
                            cpus=8, memory_mb=32768, storage_mb=51200,
                            docker_image="registry.example/tb4:original"),
                        logger=logging.getLogger("check_tb4_resources"))
                    reserve = ops.reserve
                else:
                    ops = plue_env._PlueOps()
                    ops.task_env_config = types.SimpleNamespace(
                        cpus=8, memory_mb=32768, storage_mb=51200)
                    reserve = ops._plue_reserve
                ops.logger = logging.getLogger("check_tb4_resources")
                ops.session_id = "tb4__eight_cpu__env"
                ops._plue_image = "registry.example/tb4:original"
                ops._plue_network = lambda: ("none", [])
                ops._workspace_id = ""
                ops._plue_reserved = False
                ops._plue_ledger_key = ""

                if limit == 7:
                    ops._plue_ledger = Mock(side_effect=AssertionError(
                        "CPU refusal must precede ledger allocation"))
                    try:
                        asyncio.run(reserve())
                    except plue_env.PlueUnplaceable as error:
                        assert error.code == "unplaceable", error
                        assert "8 vCPU" in str(error) and "7 vCPU" in str(error), error
                        assert "disk" not in str(error).lower(), error
                    else:
                        raise AssertionError("limit 7 must refuse the TB4 8-vCPU request")
                    ops._plue_ledger.assert_not_called()
                    assert not calls.exists(), "refusal reached the CLI"
                    assert not ledger.exists(), "refusal wrote an ownership allocation"
                    assert not ops._workspace_id and not ops._plue_reserved
                    assert not ops._plue_ledger_key
                    continue

                asyncio.run(reserve())
                captured = json.loads(calls.read_text())
                assert len(captured) == 1, captured
                args = captured[0]
                assert args[:2] == ["workspace", "create"], args
                for flag, value in (
                    ("--cpus", "8"), ("--memory", "32768"), ("--disk", "51200"),
                    ("--image", "registry.example/tb4:original"), ("--repo", "acme/tb4"),
                ):
                    assert args.count(flag) == 1 and args[args.index(flag) + 1] == value, args
                assert ops._workspace_id == "tb4-workspace" and ops._plue_reserved
                expected = [{"repo": "acme/tb4", "session": ops.session_id,
                             "id": "tb4-workspace"}]
                assert workspace_ownership.records() == expected
                asyncio.run(reserve())
                assert json.loads(calls.read_text()) == captured, "repeated reserve launched twice"
                assert workspace_ownership.records() == expected


if __name__ == "__main__":
    check_tb4_8_vcpu_request_preservation()
    boundary = "Harbor public reserve()" if EnvironmentConfig is not None else "adapter _plue_reserve() (Harbor unavailable)"
    print(f"TB4 8-vCPU request preservation: limits 8/16 pass; limit 7 refuses; repeated reserve deduplicates (offline; {boundary})")
