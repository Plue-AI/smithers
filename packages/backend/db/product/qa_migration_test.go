package product

import (
	"encoding/csv"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// QA migration-class checks. They parse files only (no database) and take a
// directory so a fixture can stand in for migrations/.
//
// Policy decisions:
//   - Names must match NNNN_snake_case.sql with a unique, gapless NNNN from 0001.
//   - "IF NOT EXISTS" is NOT accepted as an excuse for two files creating the
//     same relation: the second file silently becomes a no-op and its columns
//     never exist. A relation may be created again only after a DROP/RENAME.
//   - A table counts as installed if some migration creates it and no later
//     migration drops or renames it away.

// knownMigrationGaps freezes historical gaps in the numeric sequence. Main has
// none today; adding a number here hides a gap, so do not.
var knownMigrationGaps = []int{}

// tablesCreatedByGo are product tables that migrate.go creates itself (the
// ledger), so no .sql file mentions them.
var tablesCreatedByGo = map[string]bool{"smithers_product_migrations": true}

var migrationNameRE = regexp.MustCompile(`^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$`)

type migrationFile struct {
	name    string
	version int
	sql     string
}

func readMigrationDir(dir string) ([]migrationFile, []string) {
	var files []migrationFile
	var problems []string
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, []string{err.Error()}
	}
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".sql" {
			if !e.IsDir() {
				problems = append(problems, fmt.Sprintf("%s is not a .sql file", e.Name()))
			}
			continue
		}
		m := migrationNameRE.FindStringSubmatch(e.Name())
		if m == nil {
			problems = append(problems, fmt.Sprintf("%s does not match NNNN_snake_case.sql", e.Name()))
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			problems = append(problems, err.Error())
			continue
		}
		v, _ := strconv.Atoi(m[1])
		files = append(files, migrationFile{e.Name(), v, string(b)})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].version != files[j].version {
			return files[i].version < files[j].version
		}
		return files[i].name < files[j].name
	})
	return files, problems
}

// checkMigrationNames returns one message per naming, duplicate-number or gap problem.
func checkMigrationNames(dir string) []string {
	files, problems := readMigrationDir(dir)
	byVersion := map[int][]string{}
	for _, f := range files {
		byVersion[f.version] = append(byVersion[f.version], f.name)
	}
	max := 0
	for v, names := range byVersion {
		if v > max {
			max = v
		}
		if len(names) > 1 {
			problems = append(problems, fmt.Sprintf("duplicate migration number %04d: %s", v, strings.Join(names, " and ")))
		}
	}
	for v := 1; v <= max; v++ {
		if _, ok := byVersion[v]; !ok && !containsInt(knownMigrationGaps, v) {
			problems = append(problems, fmt.Sprintf("gap: no migration numbered %04d", v))
		}
	}
	sort.Strings(problems)
	return problems
}

func containsInt(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

var (
	lineCommentRE  = regexp.MustCompile(`--[^\n]*`)
	blockCommentRE = regexp.MustCompile(`(?s)/\*.*?\*/`)
	dollarBodyRE   = regexp.MustCompile(`(?s)\$([A-Za-z_]*)\$.*?\$([A-Za-z_]*)\$`)
	stringLitRE    = regexp.MustCompile(`'(?:[^']|'')*'`)

	ident = `(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?`

	createTableRE = regexp.MustCompile(`(?i)\bCREATE\s+(?:(?:UNLOGGED|TEMP|TEMPORARY)\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(` + ident + `)`)
	createIndexRE = regexp.MustCompile(`(?i)\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(` + ident + `)\s+ON\s+(?:ONLY\s+)?(` + ident + `)`)
	createTypeRE  = regexp.MustCompile(`(?i)\bCREATE\s+(?:TYPE|DOMAIN)\s+(` + ident + `)`)
	createOtherRE = regexp.MustCompile(`(?i)\bCREATE\s+(?:SEQUENCE|(?:MATERIALIZED\s+)?VIEW)\s+(IF\s+NOT\s+EXISTS\s+)?(` + ident + `)`)
	dropRE        = regexp.MustCompile(`(?i)\bDROP\s+(TABLE|INDEX|TYPE|DOMAIN|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?(` + ident + `(?:\s*,\s*` + ident + `)*)`)
	renameRE      = regexp.MustCompile(`(?i)\bALTER\s+(TABLE|INDEX|TYPE|SEQUENCE|VIEW)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(` + ident + `)\s+RENAME\s+TO\s+(` + ident + `)`)
)

func normIdent(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(strings.ToLower(s), "public.")
	return strings.ReplaceAll(s, `"`, "")
}

func stripSQL(sql string) string {
	sql = blockCommentRE.ReplaceAllString(sql, " ")
	sql = lineCommentRE.ReplaceAllString(sql, " ")
	sql = dollarBodyRE.ReplaceAllString(sql, " ")
	return stringLitRE.ReplaceAllString(sql, "''")
}

type objectOwner struct {
	file  string
	ifNot bool
}

// schemaWalk replays CREATE/DROP/RENAME over the files in order. Relations
// (tables, indexes, sequences, views) share one namespace; types have another.
type schemaWalk struct {
	live       map[string]objectOwner // "rel:name" / "type:name"
	tables     map[string]string      // live table -> creating file
	indexTable map[string]string      // index -> table
	problems   []string
}

func (w *schemaWalk) create(kind, name, file string, ifNot bool) {
	key := kind + ":" + name
	if prev, ok := w.live[key]; ok {
		w.problems = append(w.problems, fmt.Sprintf("%s %s is created by both %s and %s", kind, name, prev.file, file))
		return
	}
	w.live[key] = objectOwner{file, ifNot}
}

func (w *schemaWalk) drop(kind, name string) {
	k := "rel"
	if kind == "type" || kind == "domain" {
		k = "type"
	}
	delete(w.live, k+":"+name)
	if kind == "table" {
		delete(w.tables, name)
		for idx, tbl := range w.indexTable {
			if tbl == name {
				delete(w.indexTable, idx)
				delete(w.live, "rel:"+idx)
			}
		}
	}
	if kind == "index" {
		delete(w.indexTable, name)
	}
}

type schemaEvent struct {
	pos  int
	kind string // table, index, type, other, rename, drop
	m    []string
}

func walkSchema(files []migrationFile) *schemaWalk {
	w := &schemaWalk{live: map[string]objectOwner{}, tables: map[string]string{}, indexTable: map[string]string{}}
	for _, f := range files {
		sql := stripSQL(f.sql)
		var events []schemaEvent
		for kind, re := range map[string]*regexp.Regexp{"table": createTableRE, "index": createIndexRE, "type": createTypeRE, "other": createOtherRE, "rename": renameRE, "drop": dropRE} {
			for _, loc := range re.FindAllStringSubmatchIndex(sql, -1) {
				var m []string
				for i := 0; i < len(loc); i += 2 {
					if loc[i] < 0 {
						m = append(m, "")
					} else {
						m = append(m, sql[loc[i]:loc[i+1]])
					}
				}
				events = append(events, schemaEvent{loc[0], kind, m})
			}
		}
		sort.Slice(events, func(i, j int) bool { return events[i].pos < events[j].pos })
		for _, ev := range events {
			m := ev.m
			switch ev.kind {
			case "table":
				name := normIdent(m[2])
				w.create("rel", name, f.name, m[1] != "")
				if _, ok := w.tables[name]; !ok {
					w.tables[name] = f.name
				}
			case "index":
				name := normIdent(m[2])
				w.create("rel", name, f.name, m[1] != "")
				w.indexTable[name] = normIdent(m[3])
			case "type":
				w.create("type", normIdent(m[1]), f.name, false)
			case "other":
				w.create("rel", normIdent(m[2]), f.name, m[1] != "")
			case "rename":
				kind, from, to := strings.ToLower(m[1]), normIdent(m[2]), normIdent(m[3])
				ns := "rel"
				if kind == "type" {
					ns = "type"
				}
				if o, ok := w.live[ns+":"+from]; ok {
					delete(w.live, ns+":"+from)
					w.live[ns+":"+to] = o
				}
				if kind == "table" {
					if file, ok := w.tables[from]; ok {
						delete(w.tables, from)
						w.tables[to] = file
					}
					for idx, tbl := range w.indexTable {
						if tbl == from {
							w.indexTable[idx] = to
						}
					}
				}
			case "drop":
				kind := strings.ToLower(strings.Fields(m[1])[0])
				for _, n := range strings.Split(m[2], ",") {
					w.drop(kind, normIdent(n))
				}
			}
		}
	}
	sort.Strings(w.problems)
	return w
}

func checkDuplicateObjects(dir string) []string {
	files, problems := readMigrationDir(dir)
	return append(problems, walkSchema(files).problems...)
}

// checkOwnership compares tables that survive the migrations with the product
// rows of an ownership.csv (same header and rules as ownershipRows).
func checkOwnership(dir, csvPath string) []string {
	files, problems := readMigrationDir(dir)
	live := walkSchema(files).tables
	f, err := os.Open(csvPath)
	if err != nil {
		return append(problems, err.Error())
	}
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	if err != nil || len(rows) < 2 {
		return append(problems, fmt.Sprintf("ownership.csv unreadable: %v", err))
	}
	owners := map[string]string{}
	for _, r := range rows[1:] {
		owners[r[0]] = r[1]
	}
	for t, file := range live {
		switch o, ok := owners[t]; {
		case !ok:
			problems = append(problems, fmt.Sprintf("table %s (created by %s) has no row in ownership.csv", t, file))
		case o != "product":
			problems = append(problems, fmt.Sprintf("table %s (created by %s) is marked %q in ownership.csv", t, file, o))
		}
	}
	for t, o := range owners {
		if _, ok := live[t]; o == "product" && !ok && !tablesCreatedByGo[t] {
			problems = append(problems, fmt.Sprintf("ownership.csv lists product table %s that no migration leaves installed", t))
		}
	}
	sort.Strings(problems)
	return problems
}

func report(t *testing.T, problems []string) {
	t.Helper()
	for _, p := range problems {
		t.Error(p)
	}
}

func TestQAMigrationNamesUniqueAndGapless(t *testing.T) {
	report(t, checkMigrationNames("migrations"))
}

// Every file the embed picks up is registered, and every registered path is a
// file in the embed, in order, versions 1..N.
func TestQAMigrationRegistryMatchesEmbed(t *testing.T) {
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	reg := map[string]int{}
	for i, s := range migrationRegistry {
		reg[s.path] = s.version
		if s.version != i+1 {
			t.Errorf("registry entry %d (%s) has version %d", i+1, s.path, s.version)
		}
		if _, err := fs.Stat(migrations, s.path); err != nil {
			t.Errorf("registry lists %s, which is not embedded", s.path)
		}
	}
	for _, f := range files {
		if _, ok := reg[f]; !ok {
			t.Errorf("embedded %s is missing from migrationRegistry", f)
		}
	}
	if len(files) != len(migrationRegistry) {
		t.Errorf("%d embedded files, %d registry entries", len(files), len(migrationRegistry))
	}
	// The embed must see everything on disk too (a subdirectory or odd name would be skipped).
	disk, _ := os.ReadDir("migrations")
	if len(disk) != len(files) {
		t.Errorf("migrations/ holds %d entries, embed matches %d .sql files", len(disk), len(files))
	}
}

func TestQAMigrationNoDuplicateObjects(t *testing.T) {
	report(t, checkDuplicateObjects("migrations"))
}

func TestQAMigrationOwnershipExhaustive(t *testing.T) {
	report(t, checkOwnership("migrations", "../ownership.csv"))
}

// Regression: the 0104 collision. Two files with the same number both
// creating install_settings must trip the name and object checks, naming both.
func TestQAMigrationRegressionFixtureDuplicate0104(t *testing.T) {
	dir := t.TempDir()
	for _, n := range []string{"0104_stk_install_settings.sql", "0104_gh_install_settings.sql"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("CREATE TABLE install_settings (id bigint PRIMARY KEY);\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, c := range []struct {
		name  string
		check func(string) []string
	}{{"names", checkMigrationNames}, {"objects", checkDuplicateObjects}} {
		got := strings.Join(c.check(dir), "\n")
		for _, f := range []string{"0104_stk_install_settings.sql", "0104_gh_install_settings.sql"} {
			if !strings.Contains(got, f) {
				t.Errorf("%s check does not name %s; got:\n%s", c.name, f, got)
			}
		}
		if got == "" {
			t.Errorf("%s check passed on a duplicate fixture", c.name)
		}
	}
}

// Different numbers, same table: only the object check fires. IF NOT EXISTS
// does not excuse it. A DROP between them does.
func TestQAMigrationRegressionFixtureObjects(t *testing.T) {
	write := func(files map[string]string) string {
		dir := t.TempDir()
		for n, s := range files {
			if err := os.WriteFile(filepath.Join(dir, n), []byte(s), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}
	dir := write(map[string]string{
		"0001_a.sql": "CREATE TABLE install_settings (id int);\nCREATE INDEX a_idx ON install_settings (id);",
		"0002_b.sql": "CREATE TABLE IF NOT EXISTS install_settings (id int);\nCREATE TYPE mood AS ENUM ('a');",
		"0003_c.sql": "CREATE TYPE public.mood AS ENUM ('b');\nCREATE UNIQUE INDEX a_idx ON other (id);",
	})
	got := strings.Join(checkDuplicateObjects(dir), "\n")
	for _, want := range []string{"install_settings is created by both 0001_a.sql and 0002_b.sql", "mood is created by both 0002_b.sql and 0003_c.sql", "a_idx is created by both 0001_a.sql and 0003_c.sql"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	ok := write(map[string]string{
		"0001_a.sql": "CREATE TABLE t (id int);\nCREATE INDEX t_idx ON t (id);\n-- CREATE TABLE commented (x int);",
		"0002_b.sql": "DROP TABLE t;\nCREATE TABLE t (id int);\nCREATE INDEX t_idx ON t (id);",
	})
	if p := checkDuplicateObjects(ok); len(p) != 0 {
		t.Errorf("drop-then-recreate flagged: %v", p)
	}
	// Ownership fixture: an unlisted table is named with its file.
	csvPath := filepath.Join(t.TempDir(), "ownership.csv")
	os.WriteFile(csvPath, []byte("table,target_owner,status\nt,product,x\nghost,product,x\n"), 0o644)
	got = strings.Join(checkOwnership(write(map[string]string{"0001_a.sql": "CREATE TABLE t (i int);\nCREATE TABLE unlisted (i int);"}), csvPath), "\n")
	if !strings.Contains(got, "unlisted (created by 0001_a.sql)") || !strings.Contains(got, "ghost") {
		t.Errorf("ownership fixture not flagged: %s", got)
	}
}

// QA_MIGRATION_LANE_DIR points at a directory of extra migration files (a
// lane's 0104*.sql). They are added to main's and every check runs.
func TestQAMigrationLaneOverlay(t *testing.T) {
	extra := os.Getenv("QA_MIGRATION_LANE_DIR")
	if extra == "" {
		t.Skip("QA_MIGRATION_LANE_DIR not set")
	}
	dir := t.TempDir()
	for _, src := range []string{"migrations", extra} {
		entries, err := os.ReadDir(src)
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			b, _ := os.ReadFile(filepath.Join(src, e.Name()))
			os.WriteFile(filepath.Join(dir, e.Name()), b, 0o644)
		}
	}
	report(t, checkMigrationNames(dir))
	report(t, checkDuplicateObjects(dir))
	report(t, checkOwnership(dir, "../ownership.csv"))
}
