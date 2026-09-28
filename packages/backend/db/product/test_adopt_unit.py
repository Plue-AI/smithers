"""Database-free adoption contracts; psql/pg_dump are controlled command boundaries."""
import contextlib
import importlib.util
import io
import json
import runpy
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

_spec = importlib.util.spec_from_file_location("product_adopt_unit", Path(__file__).with_name("adopt.py"))
adopt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(adopt)

TABLE = ("users", "TABLE", "public")
BASE = "CREATE TABLE public.users (\n    id bigint,\n    name text\n);"


class AdoptionUnits(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.baseline = self.root / "0001_product_baseline.sql"
        self.baseline.write_text(BASE)
        self.ownership = self.root / "ownership.csv"
        self.ownership.write_text("table,target_owner\nusers,product\nprivate_jobs,private\nretired_jobs,retired\n")
        for name, value in [("BASELINE", self.baseline), ("OWNERSHIP", self.ownership)]:
            scoped = patch.object(adopt, name, value)
            scoped.start()
            self.addCleanup(scoped.stop)

    def manifest(self, value):
        path = self.root / "overlays.json"
        path.write_text(json.dumps(value))
        return str(path)

    def test_comparable_table_order_and_real_column_changes(self):
        reordered = "CREATE TABLE public.users (\n name text,\n id bigint\n);"
        self.assertEqual(adopt.comparable(BASE, "TABLE"), "CREATE TABLE public.users (\nid bigint\nname text")
        self.assertEqual(adopt.comparable(reordered, "TABLE"), adopt.comparable(BASE, "TABLE"))
        self.assertNotEqual(adopt.comparable(BASE.replace("bigint", "integer"), "TABLE"), adopt.comparable(BASE, "TABLE"))
        self.assertEqual(adopt.comparable("not a table", "TABLE"), "not a table")
        incomplete = "CREATE TABLE public.users (\n id bigint"
        self.assertEqual(adopt.comparable(incomplete, "TABLE"), incomplete)

    def test_comparable_normalizes_only_literal_array_casts(self):
        self.assertEqual(adopt.comparable("CHECK (v = ANY ((ARRAY[('a'::character varying)::text, 'b'::character varying])::text[]))", "CONSTRAINT"), "CHECK (v = ANY (ARRAY['a', 'b']))")
        outside = "CHECK (v = ('a'::character varying)::text)"
        self.assertEqual(adopt.comparable(outside, "CONSTRAINT"), outside)

    def test_function_comments_settings_and_body_changes(self):
        source = "-- header\n\nCREATE FUNCTION f()\n  -- note\nSELECT 1;\nSET default_tablespace = '';\nSET default_table_access_method = heap;"
        self.assertEqual(adopt.comparable(source, "FUNCTION"), "CREATE FUNCTION f()\nSELECT 1;")
        self.assertNotEqual(adopt.comparable(source.replace("SELECT 1", "SELECT 2"), "FUNCTION"), adopt.comparable(source, "FUNCTION"))
        self.assertEqual(adopt.object_hash("abc", "INDEX"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

    def test_command_preserves_output_and_reports_process_failure(self):
        with patch.object(adopt.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "result\n", "")) as run:
            self.assertEqual(adopt.command("psql", "-X", input_text="transaction"), "result\n")
            run.assert_called_once_with(("psql", "-X"), input="transaction", text=True, capture_output=True)
        with patch.object(adopt.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", " refused \n")):
            with self.assertRaisesRegex(RuntimeError, "^psql failed: refused$"):
                adopt.command("psql")

    def test_dump_boundaries_and_missing_footer(self):
        raw = "preamble\n-- Name: users; Type: TABLE; Schema: public; Owner: -\n" + BASE + "\n-- Name: idx; Type: INDEX; Schema: public; Owner: -\nCREATE INDEX idx ON public.users(id);\n"
        for suffix in ["", adopt.END + "\nignored"]:
            with self.subTest(suffix=suffix), patch.object(adopt, "command", return_value=raw + suffix):
                self.assertEqual(adopt.dump("target"), {TABLE: BASE, ("idx", "INDEX", "public"): "CREATE INDEX idx ON public.users(id);"})

    def test_overlay_valid_private_obsolete_and_invalid_admission(self):
        self.assertEqual(adopt.read_overlays(None), {})
        private = {"object": "INDEX public.idx", "sha256": ["one", "two", "one"], "disposition": "private"}
        obsolete = {"object": "TABLE public.old", "sha256": ["old"], "disposition": "obsolete"}
        valid = {"version": 1, "objects": [private, obsolete]}
        self.assertEqual(adopt.read_overlays(self.manifest(valid)), {"INDEX public.idx": ({"one", "two"}, "private"), "TABLE public.old": ({"old"}, "obsolete")})
        for value in [
            {"version": 2, "objects": []},
            {"version": 1, "objects": {}},
            {"version": 1, "objects": [private, private]},
            {"version": 1, "objects": [{"object": "x", "sha256": [], "disposition": "private"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": ["x"], "disposition": "product"}]},
        ]:
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                adopt.read_overlays(self.manifest(value))

    def test_product_drift_independent_owned_and_private_objects(self):
        expected = {TABLE: BASE, ("note", "COMMENT", "public"): "note", ("ext", "EXTENSION", "-"): "ext"}
        actual = {
            TABLE: BASE.replace("bigint", "integer"),
            ("new", "TABLE", "public"): "new",
            ("private_jobs", "TABLE", "public"): "private",
            ("retired_jobs", "TABLE", "public"): "retired",
            ("atlas_schema_revisions", "TABLE", "public"): "ledger",
            ("foreign", "TABLE", "private"): "private",
            ("idx", "INDEX", "public"): "CREATE INDEX idx ON ONLY public.users(id);",
            ("users rule", "RULE", "public"): "rule",
        }
        self.assertEqual(adopt.product_drift(expected, actual, {}, set()), [
            {"object": "INDEX public.idx", "reason": "unexpected on product table"},
            {"object": "RULE public.users rule", "reason": "unexpected on product table"},
            {"object": "TABLE public.new", "reason": "unowned or later product table"},
            {"object": "TABLE public.users", "reason": "definition differs"}])
        self.assertEqual(adopt.product_drift({TABLE: BASE}, {}, {}, set()), [{"object": "TABLE public.users", "reason": "missing"}])
        self.assertEqual(adopt.product_drift({TABLE: BASE}, {TABLE: "changed"}, {}, {TABLE}), [])

    def test_pinned_overlay_definition_and_obsolete_absence(self):
        key = ("idx", "INDEX", "public")
        overlays = {"INDEX public.idx": ({"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}, "private"), "TABLE public.old": ({"old"}, "obsolete")}
        self.assertEqual(adopt.product_drift({}, {key: "abc"}, overlays, set()), [])
        self.assertEqual(adopt.product_drift({key: "baseline index"}, {key: "abc"}, overlays, set()), [])
        self.assertEqual(adopt.product_drift({}, {key: "bad"}, overlays, set()), [{"object": "INDEX public.idx", "reason": "private overlay definition differs"}])
        self.assertEqual(adopt.product_drift({}, {}, overlays, set()), [{"object": "INDEX public.idx", "reason": "private overlay missing"}])

    def test_existing_versions_full_partial_absent_and_equivalent_tables(self):
        other = ("idx", "INDEX", "public")
        snapshots = [(2, "two", {TABLE: BASE, other: "index"}), (3, "three", {("later", "TABLE", "public"): "later"})]
        self.assertEqual(adopt.existing_versions({TABLE: BASE, other: "index"}, snapshots), ([(2, "two")], {TABLE, other}, []))
        self.assertEqual(adopt.existing_versions({TABLE: BASE}, snapshots), ([], set(), [{"object": "PRODUCT MIGRATION 2", "reason": "only some product objects already exist"}]))
        self.assertEqual(adopt.existing_versions({}, snapshots), ([], set(), []))

    def test_empty_migration_evidence_leaves_versions_pending(self):
        # Data-only updates and removed objects cannot be proven by the dump's
        # changed-object inventory. An empty inventory is not adoption evidence.
        snapshots = [(47, "data-update", {}), (50, "table-removal", {})]
        self.assertEqual(
            adopt.existing_versions({TABLE: BASE}, snapshots),
            ([], set(), []),
        )

    def test_empty_evidence_does_not_hide_a_matched_later_migration(self):
        index = ("idx", "INDEX", "public")
        snapshots = [
            (47, "data-update", {}),
            (48, "new-index", {index: "CREATE INDEX idx ON public.users(id);"}),
            (50, "table-removal", {}),
        ]
        actual = {TABLE: BASE, index: "CREATE INDEX idx ON public.users(id);"}
        self.assertEqual(
            adopt.existing_versions(actual, snapshots),
            ([(48, "new-index")], {index}, []),
        )

    def test_snapshots_only_changed_objects_and_sequence_gaps(self):
        second = self.root / "0002_index.sql"
        second.write_text("abc")
        third = self.root / "0003_table.sql"
        third.write_text("later")
        index = ("idx", "INDEX", "public")
        reordered = "CREATE TABLE public.users (\n name text,\n id bigint\n);"
        with (
            patch.object(adopt, "command") as command,
            patch.object(adopt, "dump", side_effect=[{TABLE: reordered, index: "index"}, {TABLE: BASE.replace("bigint", "integer"), index: "index"}]),
        ):
            snapshots = adopt.migration_snapshots("scratch", {TABLE: BASE})
        self.assertEqual(snapshots[0], (2, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", {index: "index"}))
        self.assertEqual(snapshots[1][0], 3)
        self.assertEqual(snapshots[1][2], {TABLE: BASE.replace("bigint", "integer")})
        self.assertEqual([call.args[-1] for call in command.call_args_list], [str(second), str(third)])
        second.unlink()
        with patch.object(adopt, "command") as command, self.assertRaisesRegex(RuntimeError, "gap at 0003_table.sql"):
            adopt.migration_snapshots("scratch", {TABLE: BASE})
        command.assert_not_called()

    def test_all_attached_object_types_are_drift_and_unrelated_objects_are_allowed(self):
        for kind in ["INDEX", "TRIGGER", "FK CONSTRAINT", "CONSTRAINT", "RULE", "POLICY"]:
            with self.subTest(kind=kind):
                key = ("extra", kind, "public")
                self.assertEqual(adopt.product_drift({TABLE: BASE}, {TABLE: BASE, key: "ON public.users"}, {}, set()), [{"object": f"{kind} public.extra", "reason": "unexpected on product table"}])
                self.assertEqual(adopt.product_drift({TABLE: BASE}, {TABLE: BASE, key: "ON public.private_jobs"}, {}, set()), [])

    def test_ledger_known_unknown_changed_and_malformed_versions(self):
        with patch.object(adopt, "sql", return_value="f") as sql:
            self.assertEqual(adopt.ledger_drift("target", {1: "one"}), [])
            self.assertEqual(sql.call_count, 1)
        for rows, expected in [
            ("", []),
            ("1|one\n2|two", []),
            ("1|changed", [{"object": "TABLE public.smithers_product_migrations", "reason": "ledger checksum differs at version 1"}]),
            ("3|three", [{"object": "TABLE public.smithers_product_migrations", "reason": "ledger checksum differs at version 3"}]),
        ]:
            with self.subTest(rows=rows), patch.object(adopt, "sql", side_effect=["t", rows]):
                self.assertEqual(adopt.ledger_drift("target", {1: "one", 2: "two"}), expected)
        with patch.object(adopt, "sql", side_effect=["t", "invalid|one"]), self.assertRaises(ValueError):
            adopt.ledger_drift("target", {})

    def test_prepare_requires_empty_scratch_and_exact_inventory(self):
        with patch.object(adopt, "sql", return_value="1"), patch.object(adopt, "command") as command:
            with self.assertRaisesRegex(RuntimeError, "no public tables"):
                adopt.prepare_baseline("scratch")
            command.assert_not_called()
        with (
            patch.object(adopt, "sql", return_value="0"),
            patch.object(adopt, "command"),
            patch.object(adopt, "dump", return_value={TABLE: BASE}),
        ):
            self.assertEqual(adopt.prepare_baseline("scratch"), {TABLE: BASE})
        with patch.object(adopt, "sql", return_value="0"), patch.object(adopt, "command"), patch.object(adopt, "dump", return_value={}):
            with self.assertRaisesRegex(RuntimeError, "table inventory"):
                adopt.prepare_baseline("scratch")

    def run_main(self, *, apply=False, actual=None, snapshots=None, versions=("180002", "180004"), overlays=None, target="target", ledger=("f",), prepare_error=None):
        argv = ["adopt", "--baseline-url", "scratch", "--target-url", target]
        if apply:
            argv.append("--apply")
        if overlays is not None:
            argv += ["--overlays", overlays]
        out, err = io.StringIO(), io.StringIO()
        with (
            patch.object(sys, "argv", argv),
            contextlib.redirect_stdout(out),
            contextlib.redirect_stderr(err),
            patch.object(adopt, "sql", side_effect=[*versions, *ledger]) as sql,
            patch.object(adopt, "prepare_baseline", return_value={TABLE: BASE}, side_effect=prepare_error) as prepare,
            patch.object(adopt, "dump", return_value={TABLE: BASE} if actual is None else actual),
            patch.object(adopt, "migration_snapshots", return_value=[] if snapshots is None else snapshots),
            patch.object(adopt, "adopt") as write,
        ):
            result = adopt.main()
            self.last_sql_calls = sql.call_count
        return result, out.getvalue(), err.getvalue(), write.call_args_list, prepare.call_count

    def test_main_plan_and_apply_only_after_all_admission_checks(self):
        for apply in [False, True]:
            with self.subTest(apply=apply):
                result, out, err, writes, _ = self.run_main(apply=apply)
                report = json.loads(out)
                self.assertEqual((result, err, report["drift"], report["adopted"], report["postgres_major"]), (0, "", [], apply, 18))
                self.assertEqual(len(writes), int(apply))
                if apply:
                    self.assertEqual(writes[0].args, ("target", report["baseline_checksum"], []))
        for kwargs, message in [
            ({"target": "scratch"}, "must differ"),
            ({"versions": ("170001", "180001")}, "major versions differ"),
            ({"versions": ("not-version", "180001")}, "invalid literal"),
        ]:
            with self.subTest(kwargs=kwargs):
                result, out, err, writes, prepared = self.run_main(apply=True, **kwargs)
                self.assertEqual((result, out, writes, prepared), (1, "", [], 0))
                self.assertIn(message, err)

    def test_main_drift_and_partial_migration_refuse_apply(self):
        key = ("idx", "INDEX", "public")
        result, out, err, writes, _ = self.run_main(apply=True, actual={TABLE: BASE}, snapshots=[(2, "two", {TABLE: BASE, key: "index"})])
        self.assertEqual((result, err, writes), (2, "", []))
        self.assertEqual(json.loads(out)["drift"], [{"object": "PRODUCT MIGRATION 2", "reason": "only some product objects already exist"}])
        result, out, _, writes, _ = self.run_main(apply=True, actual={})
        self.assertEqual((result, writes, json.loads(out)["adopted"]), (2, [], False))

    def test_main_recognizes_later_versions_and_ledger_errors_refuse_writes(self):
        index = ("idx", "INDEX", "public")
        result, out, err, writes, _ = self.run_main(apply=True, actual={TABLE: BASE, index: "index"}, snapshots=[(2, "two", {index: "index"})])
        report = json.loads(out)
        self.assertEqual((result, err, report["preexisting_migrations"], report["drift"]), (0, "", [2], []))
        self.assertEqual(writes[0].args, ("target", report["baseline_checksum"], [(2, "two")]))
        result, out, _, writes, _ = self.run_main(apply=True, ledger=("t", "1|wrong"))
        self.assertEqual((result, writes), (2, []))
        self.assertEqual(json.loads(out)["drift"], [{"object": "TABLE public.smithers_product_migrations", "reason": "ledger checksum differs at version 1"}])
        for kwargs, diagnostic in [
            ({"ledger": ("t", "not-version|x")}, "invalid literal"),
            ({"prepare_error": RuntimeError("scratch unavailable")}, "scratch unavailable"),
            ({"prepare_error": OSError("connection refused")}, "connection refused"),
        ]:
            with self.subTest(kwargs=kwargs):
                result, out, err, writes, _ = self.run_main(apply=True, **kwargs)
                self.assertEqual((result, out, writes), (1, "", []))
                self.assertIn(diagnostic, err)

    def test_main_records_only_nonempty_proven_migration_evidence(self):
        index = ("idx", "INDEX", "public")
        result, out, err, writes, _ = self.run_main(
            apply=True,
            actual={TABLE: BASE, index: "index"},
            snapshots=[(47, "data-update", {}), (48, "new-index", {index: "index"}), (50, "table-removal", {})],
        )
        report = json.loads(out)
        self.assertEqual((result, err, report["preexisting_migrations"], report["drift"]), (0, "", [48], []))
        self.assertEqual(writes[0].args, ("target", report["baseline_checksum"], [(48, "new-index")]))

    def test_main_real_pipeline_only_crosses_controlled_command_boundary(self):
        for apply in [False, True]:
            with self.subTest(apply=apply):
                calls = []
                raw = "-- Name: users; Type: TABLE; Schema: public; Owner: -\n" + BASE + "\n" + adopt.END

                def boundary(*args, input_text=None):
                    calls.append((args, input_text))
                    url = args[args.index("-d") + 1]
                    if args[0] == "pg_dump":
                        self.assertEqual(args, ("pg_dump", "--schema-only", "--no-owner", "--no-privileges", "-d", url))
                        self.assertIn(url, {"scratch", "target"})
                        return raw
                    self.assertEqual(args[0], "psql")
                    if "-c" in args:
                        statement = args[-1]
                        if statement == "SHOW server_version_num":
                            return "180002\n"
                        if statement.startswith("SELECT count(*)"):
                            self.assertEqual(url, "scratch")
                            return "0\n"
                        self.assertEqual(url, "target")
                        self.assertEqual(statement, "SELECT to_regclass('public.smithers_product_migrations') IS NOT NULL")
                        return "f\n"
                    if "-f" in args:
                        self.assertEqual((url, args[-1]), ("scratch", str(self.baseline)))
                        self.assertIn("-1", args)
                        return ""
                    self.assertTrue(apply)
                    self.assertEqual(url, "target")
                    self.assertIsNotNone(input_text)
                    self.assertIn("CREATE TABLE public.smithers_product_migrations", input_text)
                    self.assertNotIn("CREATE TABLE public.users", input_text)
                    self.assertNotIn("DROP ", input_text)
                    return ""

                argv = ["adopt", "--baseline-url", "scratch", "--target-url", "target"]
                if apply:
                    argv.append("--apply")
                output = io.StringIO()
                with (
                    patch.object(sys, "argv", argv),
                    patch.object(adopt, "command", side_effect=boundary), contextlib.redirect_stdout(output),
                ):
                    self.assertEqual(adopt.main(), 0)
                report = json.loads(output.getvalue())
                self.assertEqual((report["drift"], report["adopted"], report["product_objects"]), ([], apply, 1))
                self.assertEqual(sum(text is not None for _, text in calls), int(apply))

    def test_script_entrypoint_refuses_same_database_before_any_command(self):
        errors = io.StringIO()
        argv = ["adopt.py", "--baseline-url", "same", "--target-url", "same", "--apply"]
        with (
            patch.object(sys, "argv", argv),
            contextlib.redirect_stderr(errors),
            patch.object(subprocess, "run") as command,
            self.assertRaises(SystemExit) as exited,
        ):
            runpy.run_path(str(Path(__file__).with_name("adopt.py")), run_name="__main__")
        self.assertEqual(exited.exception.code, 1)
        self.assertEqual(errors.getvalue(), "product baseline adoption: baseline and target databases must differ\n")
        command.assert_not_called()

    def test_missing_or_invalid_json_overlay_refuses_before_database_access(self):
        malformed = self.root / "malformed.json"
        malformed.write_text("{")
        for path in [self.root / "missing.json", malformed]:
            with self.subTest(path=path):
                result, out, err, writes, prepared = self.run_main(apply=True, overlays=str(path))
                self.assertEqual((result, out, writes, prepared, self.last_sql_calls), (1, "", [], 0, 0))
                self.assertIn("product baseline adoption:", err)

    def test_main_malformed_overlay_refuses_without_uncaught_exception(self):
        for value in [
            None, [], "manifest", 1, True,
            {"version": True, "objects": []},
            {"version": 1.0, "objects": []},
            {"version": "1", "objects": []},
            {"version": 1, "objects": [True]},
            {"version": 1, "objects": [{"object": "", "sha256": ["hash"], "disposition": "private"}]},
            {"version": 1, "objects": [{"object": 1, "sha256": ["hash"], "disposition": "private"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": "hash", "disposition": "private"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": {"hash": 1}, "disposition": "private"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": [""], "disposition": "private"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": [1], "disposition": "private"}]},
            {"version": 1, "objects": [None]},
            {"version": 1, "objects": [1]},
            {"version": 1, "objects": ["entry"]},
            {"version": 1, "objects": [{}]},
            {"version": 1, "objects": [{"object": "x"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": ["hash"]}]},
            {"version": 1, "objects": [{"object": [], "sha256": ["hash"], "disposition": "private"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": [["hash"]], "disposition": "private"}]},
            {"version": 1, "objects": [{"object": "x", "sha256": ["hash"], "disposition": []}]},
        ]:
            with self.subTest(value=value):
                result, out, err, writes, prepared = self.run_main(apply=True, overlays=self.manifest(value))
                self.assertEqual((result, out, writes, prepared), (1, "", [], 0))
                self.assertEqual(self.last_sql_calls, 0)
                self.assertIn("product baseline adoption:", err)


if __name__ == "__main__":
    unittest.main()
