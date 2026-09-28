#!/usr/bin/env python3
"""Fail-closed, one-time adoption of the Smithers product baseline.

The baseline URL must name an empty scratch database on the same PostgreSQL
major version as the target. The tool installs the checked-in baseline there.
Without --apply it only reads the target. It never alters product objects.
"""

import argparse
import csv
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys


BASELINE = Path(__file__).resolve().parent / "migrations" / "0001_product_baseline.sql"
OWNERSHIP = Path(__file__).resolve().parent.parent / "ownership.csv"
HEADER = re.compile(r"^-- Name: (.*?); Type: (.*?); Schema: (.*?); Owner: -$", re.M)
TABLE = re.compile(r"^CREATE TABLE (?:public\.)?([a-z][a-z0-9_]*) \(", re.M)
END = "-- PostgreSQL database dump complete"
PRIVATE_MIGRATION_TABLES = {"atlas_schema_revisions", "smithers_product_migrations"}


def command(*args: str, input_text: str | None = None) -> str:
    result = subprocess.run(args, input=input_text, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {result.stderr.strip()}")
    return result.stdout


def sql(url: str, statement: str) -> str:
    return command("psql", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url,
                   "-c", statement).strip()


def dump(url: str) -> dict[tuple[str, str, str], str]:
    raw = command("pg_dump", "--schema-only", "--no-owner", "--no-privileges", "-d", url)
    headers = list(HEADER.finditer(raw))
    objects: dict[tuple[str, str, str], str] = {}
    for index, header in enumerate(headers):
        limit = headers[index + 1].start() if index + 1 < len(headers) else raw.find(END, header.end())
        if limit < 0:
            limit = len(raw)
        key = header.groups()
        objects[key] = raw[header.end():limit].strip()
    return objects


def comparable(definition: str, kind: str) -> str:
    # The two equivalent pg_dump spellings below result from a CHECK written
    # before vs. after a column's varchar type was resolved by PostgreSQL.
    # Normalize only literal arrays with an explicit varchar-to-text cast.
    definition = re.sub(r"\(ARRAY\[([^\]]*)\]\)::text\[\]", r"ARRAY[\1]", definition)

    def normalize_array(match: re.Match[str]) -> str:
        array = match.group(0)
        array = re.sub(r"\('([^']*)'::character varying\)::text", r"'\1'", array)
        return re.sub(r"'([^']*)'::character varying", r"'\1'", array)

    definition = re.sub(r"ARRAY\[[^\]]*\]", normalize_array, definition)
    if kind == "FUNCTION":
        # pg_dump may place database-wide table settings after a function
        # section. SQL line comments and blank lines do not change the body.
        return "\n".join(
            line for line in definition.splitlines()
            if line.strip() and not line.lstrip().startswith("--")
            and not line.startswith("SET default_tablespace")
            and not line.startswith("SET default_table_access_method")
        )
    if kind != "TABLE":
        return definition
    # PostgreSQL retains physical column order from the historical Plue
    # migrations. A fresh baseline may declare the same columns in a different
    # order; that order does not change the named-column product contract.
    start = definition.find("CREATE TABLE ")
    end = definition.find("\n);", start)
    if start < 0 or end < 0:
        return definition
    lines = definition[start:end].splitlines()
    return "\n".join([lines[0]] + sorted(line.strip().rstrip(",") for line in lines[1:]))


def object_name(key: tuple[str, str, str]) -> str:
    name, kind, schema = key
    return f"{kind} {schema}.{name}"


def read_overlays(path: str | None) -> dict[str, tuple[set[str], str]]:
    if path is None:
        return {}
    manifest = json.loads(Path(path).read_text())
    if (not isinstance(manifest, dict) or type(manifest.get("version")) is not int
            or manifest["version"] != 1 or not isinstance(manifest.get("objects"), list)):
        raise RuntimeError("invalid private overlay manifest")
    overlays: dict[str, tuple[set[str], str]] = {}
    for entry in manifest["objects"]:
        if not isinstance(entry, dict):
            raise RuntimeError("invalid private overlay entry")
        name, hashes, disposition = entry.get("object"), entry.get("sha256"), entry.get("disposition")
        if not isinstance(name, str) or not name:
            raise RuntimeError("invalid private overlay object name")
        if (name in overlays or not isinstance(disposition, str)
                or disposition not in {"private", "obsolete"}
                or not isinstance(hashes, list) or not hashes
                or any(not isinstance(value, str) or not value for value in hashes)):
            raise RuntimeError(f"invalid private overlay: {name}")
        overlays[name] = (set(hashes), disposition)
    return overlays


def object_hash(definition: str, kind: str) -> str:
    return hashlib.sha256(comparable(definition, kind).encode()).hexdigest()


def product_drift(expected: dict, actual: dict, overlays: dict[str, tuple[set[str], str]],
                  later: set[tuple[str, str, str]]) -> list[dict[str, str]]:
    product_tables = {name for (name, kind, schema) in expected
                      if kind == "TABLE" and schema == "public"}
    drift = []
    for name, (hashes, disposition) in sorted(overlays.items()):
        matches = [key for key in actual if object_name(key) == name]
        if not matches and disposition == "obsolete":
            continue
        if len(matches) != 1:
            drift.append({"object": name, "reason": "private overlay missing"})
        elif object_hash(actual[matches[0]], matches[0][1]) not in hashes:
            drift.append({"object": name, "reason": "private overlay definition differs"})
    for key in sorted(expected):
        name, kind, schema = key
        if kind == "COMMENT" or (kind == "EXTENSION" and schema == "-"):
            continue
        if key in later or object_name(key) in overlays:
            continue
        if key not in actual:
            drift.append({"object": f"{kind} {schema}.{name}", "reason": "missing"})
        elif comparable(actual[key], kind) != comparable(expected[key], kind):
            drift.append({"object": f"{kind} {schema}.{name}", "reason": "definition differs"})
    with OWNERSHIP.open(newline="") as manifest:
        table_owners = {row["table"]: row["target_owner"] for row in csv.DictReader(manifest)}
    # A new trigger, index, constraint, or column on an owned table is product
    # drift even if it has no counterpart in the baseline. This also catches
    # Plue placement columns grafted onto product repository rows.
    for key in sorted(actual.keys() - expected.keys()):
        name, kind, schema = key
        if key in later or object_name(key) in overlays:
            continue
        if schema != "public":
            continue
        if kind == "TABLE" and name not in PRIVATE_MIGRATION_TABLES and table_owners.get(name) not in {"private", "retired"}:
            drift.append({"object": f"TABLE public.{name}", "reason": "unowned or later product table"})
            continue
        definition = actual[key]
        attached = any(name.startswith(table + " ") for table in product_tables)
        if kind in {"INDEX", "TRIGGER", "FK CONSTRAINT", "CONSTRAINT", "RULE", "POLICY"}:
            attached |= any(f"ON public.{table}" in definition or
                            f"ON ONLY public.{table}" in definition for table in product_tables)
        if attached:
            drift.append({"object": f"{kind} {schema}.{name}", "reason": "unexpected on product table"})
    return sorted(drift, key=lambda item: (item["object"], item["reason"]))


def migration_snapshots(url: str, baseline: dict) -> list[tuple[int, str, dict]]:
    previous = baseline
    snapshots = []
    for version, path in enumerate(sorted(BASELINE.parent.glob("[0-9][0-9][0-9][0-9]_*.sql"))[1:], start=2):
        if int(path.name[:4]) != version:
            raise RuntimeError(f"product migration sequence has a gap at {path.name}")
        command("psql", "-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-d", url, "-f", str(path))
        current = dump(url)
        changed = {key: definition for key, definition in current.items()
                   if key not in previous or comparable(definition, key[1]) != comparable(previous[key], key[1])}
        snapshots.append((version, hashlib.sha256(path.read_bytes()).hexdigest(), changed))
        previous = current
    return snapshots


def existing_versions(actual: dict, snapshots: list[tuple[int, str, dict]]) -> tuple[list[tuple[int, str]], set, list]:
    recognized = []
    later: set[tuple[str, str, str]] = set()
    drift = []
    for version, checksum, changed in snapshots:
        matches = {key for key, definition in changed.items() if key in actual
                   and comparable(actual[key], key[1]) == comparable(definition, key[1])}
        # A data-only or removal-only migration leaves no positive schema
        # evidence. Keep it pending rather than infer that it already ran.
        if changed and len(matches) == len(changed):
            recognized.append((version, checksum))
            later.update(changed)
        elif matches:
            drift.append({"object": f"PRODUCT MIGRATION {version}",
                          "reason": "only some product objects already exist"})
    return recognized, later, drift


def ledger_drift(url: str, checksums: dict[int, str]) -> list[dict[str, str]]:
    if sql(url, "SELECT to_regclass('public.smithers_product_migrations') IS NOT NULL") == "f":
        return []
    rows = sql(url, "SELECT version::text || '|' || checksum "
                    "FROM public.smithers_product_migrations ORDER BY version")
    for row in rows.splitlines():
        version_text, _, checksum = row.partition("|")
        version = int(version_text)
        if checksums.get(version) != checksum:
            return [{"object": "TABLE public.smithers_product_migrations",
                     "reason": f"ledger checksum differs at version {version}"}]
    return []


def prepare_baseline(url: str) -> dict:
    existing = sql(url, "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n "
                        "ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")
    if existing != "0":
        raise RuntimeError("baseline scratch database must have no public tables")
    command("psql", "-X", "-q", "-1", "-v", "ON_ERROR_STOP=1", "-d", url, "-f", str(BASELINE))
    objects = dump(url)
    installed = {name for (name, kind, schema) in objects if kind == "TABLE" and schema == "public"}
    declared = set(TABLE.findall(BASELINE.read_text()))
    if installed != declared:
        raise RuntimeError("scratch database does not match baseline table inventory")
    return objects


def adopt(url: str, checksum: str, existing: list[tuple[int, str]]) -> None:
    # The ledger is the only target write. A transaction and the same advisory
    # lock as product.Apply make a concurrent product migration wait.
    command("psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", url, input_text=f"""
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('smithers:product:migration', 0));
DO $$ BEGIN
    IF to_regclass('public.smithers_product_migrations') IS NOT NULL THEN
        RAISE EXCEPTION 'product migration ledger already exists';
    END IF;
END $$;
CREATE TABLE public.smithers_product_migrations (
    version integer PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.smithers_product_migrations(version, checksum) VALUES (1, '{checksum}');
{''.join(f"INSERT INTO public.smithers_product_migrations(version, checksum) VALUES ({version}, '{digest}');" for version, digest in existing)}
COMMIT;
""")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-url", required=True, help="empty scratch PostgreSQL database")
    parser.add_argument("--target-url", required=True, help="existing Plue PostgreSQL database")
    parser.add_argument("--overlays", help="pinned Plue-private object definitions allowed during adoption")
    parser.add_argument("--apply", action="store_true", help="record verified baseline in target ledger")
    args = parser.parse_args()
    try:
        if args.baseline_url == args.target_url:
            raise RuntimeError("baseline and target databases must differ")
        overlays = read_overlays(args.overlays)
        baseline_version = int(sql(args.baseline_url, "SHOW server_version_num")) // 10000
        target_version = int(sql(args.target_url, "SHOW server_version_num")) // 10000
        if baseline_version != target_version:
            raise RuntimeError("baseline and target PostgreSQL major versions differ")
        expected = prepare_baseline(args.baseline_url)
        actual = dump(args.target_url)
        snapshots = migration_snapshots(args.baseline_url, expected)
        existing, later, partial = existing_versions(actual, snapshots)
        checksum = hashlib.sha256(BASELINE.read_bytes()).hexdigest()
        checksums = {1: checksum, **{version: digest for version, digest, _ in snapshots}}
        drift = (product_drift(expected, actual, overlays, later)
                 + partial + ledger_drift(args.target_url, checksums))
        drift.sort(key=lambda item: (item["object"], item["reason"]))
        if args.apply and not drift:
            adopt(args.target_url, checksum, existing)
        report = {"baseline_checksum": checksum, "postgres_major": target_version,
                  "product_objects": len(expected), "drift": drift,
                  "preexisting_migrations": [version for version, _ in existing],
                  "adopted": bool(args.apply and not drift)}
        print(json.dumps(report, indent=2, sort_keys=True))
        return 2 if drift else 0
    except (OSError, RuntimeError, ValueError) as error:
        print(f"product baseline adoption: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
