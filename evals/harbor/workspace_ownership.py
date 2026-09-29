"""Durable host-owned receipts for workspaces created by the Harbor adapter."""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
from collections.abc import Iterator
from pathlib import Path


def _path() -> Path:
    return Path(os.environ.get("PLUE_WORKSPACE_LEDGER") or
                Path.home() / ".local/state/smithers/harbor-workspaces.json")


@contextlib.contextmanager
def _locked() -> Iterator[tuple[Path, list[dict[str, str]]]]:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            rows = json.loads(path.read_text()) if path.exists() else []
            if not isinstance(rows, list) or any(
                not isinstance(row, dict) or any(
                    not isinstance(row.get(key), str) or not row[key]
                    for key in ("repo", "session", "id")) for row in rows
            ):
                raise ValueError("invalid Harbor workspace ownership ledger")
            yield path, rows
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def _save(path: Path, rows: list[dict[str, str]]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(rows, out)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def record(repo: str, session: str, workspace_id: str) -> None:
    if not all(isinstance(value, str) and value for value in (repo, session, workspace_id)):
        raise ValueError("workspace receipt requires repository, session and ID")
    with _locked() as (path, rows):
        matching = [row for row in rows if row["repo"] == repo and row["id"] == workspace_id]
        receipt = {"repo": repo, "session": session, "id": workspace_id}
        if matching and matching != [receipt]:
            raise ValueError("workspace ID already belongs to another session")
        if not matching:
            rows.append(receipt)
            _save(path, rows)


def records() -> list[dict[str, str]]:
    with _locked() as (_, rows):
        return rows


def forget(repo: str, workspace_id: str) -> None:
    with _locked() as (path, rows):
        _save(path, [row for row in rows if (row["repo"], row["id"]) != (repo, workspace_id)])


def is_missing(code: str, message: str) -> bool:
    """Recognize the public CLI's wrapped workspace 404, not arbitrary failures."""
    return code == "not_found" or (code == "command_failed" and
        "-> 404:" in message and "workspace not found" in message.lower())
