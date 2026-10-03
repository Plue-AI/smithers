package product

import (
	"encoding/csv"
	"fmt"
	"io/fs"
	"os"
	"path"
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
		if f.version == 0 {
			problems = append(problems, "migration numbers must start at 0001")
		}
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
		if _, ok := byVersion[v]; !ok {
			problems = append(problems, fmt.Sprintf("gap: no migration numbered %04d", v))
		}
	}
	sort.Strings(problems)
	return problems
}

var (
	ident = `(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?`

	createTableRE = regexp.MustCompile(`(?i)\bCREATE\s+(?:(?:UNLOGGED|TEMP|TEMPORARY)\s+)?TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(` + ident + `)`)
	createIndexRE = regexp.MustCompile(`(?i)\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(IF\s+NOT\s+EXISTS\s+)?(` + ident + `)\s+ON\s+(?:ONLY\s+)?(` + ident + `)`)
	createTypeRE  = regexp.MustCompile(`(?i)\bCREATE\s+(?:TYPE|DOMAIN)\s+(` + ident + `)`)
	createOtherRE = regexp.MustCompile(`(?i)\bCREATE\s+(?:SEQUENCE|(?:MATERIALIZED\s+)?VIEW)\s+(IF\s+NOT\s+EXISTS\s+)?(` + ident + `)`)
	dropRE        = regexp.MustCompile(`(?i)\bDROP\s+(TABLE|INDEX|TYPE|DOMAIN|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+EXISTS\s+)?(` + ident + `(?:\s*,\s*` + ident + `)*)`)
	renameRE      = regexp.MustCompile(`(?i)\bALTER\s+(TABLE|INDEX|TYPE|SEQUENCE|VIEW)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(` + ident + `)\s+RENAME\s+TO\s+(` + ident + `)`)
)

func normIdent(s string) string {
	// PostgreSQL folds only unquoted identifiers. Strip the public schema,
	// including its quoted spelling, but preserve other schema identities.
	parts := regexp.MustCompile(`"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*`).FindAllString(s, -1)
	for i, p := range parts {
		if strings.HasPrefix(p, `"`) {
			parts[i] = strings.ReplaceAll(p[1:len(p)-1], `""`, `"`)
		} else {
			parts[i] = strings.ToLower(p)
		}
	}
	if len(parts) == 2 && parts[0] == "public" {
		parts = parts[1:]
	}
	return strings.Join(parts, ".")
}

// A lexical pass, never SQL execution. Mask literals/comments while retaining
// offsets and quoted identifiers. Comments nest; dollar delimiters must match.
func stripSQL(sql string) (string, error) {
	out := []byte(sql)
	mask := func(a, b int) {
		for i := a; i < b; i++ {
			if out[i] != '\n' {
				out[i] = ' '
			}
		}
	}
	dollar := regexp.MustCompile(`^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$`)
	for i := 0; i < len(sql); {
		start := i
		switch {
		case strings.HasPrefix(sql[i:], "--"):
			if end := strings.IndexByte(sql[i:], '\n'); end >= 0 {
				i += end
			} else {
				i = len(sql)
			}
			mask(start, i)
		case strings.HasPrefix(sql[i:], "/*"):
			i += 2
			depth := 1
			for i < len(sql) && depth > 0 {
				if strings.HasPrefix(sql[i:], "/*") {
					depth++
					i += 2
				} else if strings.HasPrefix(sql[i:], "*/") {
					depth--
					i += 2
				} else {
					i++
				}
			}
			if depth != 0 {
				return "", fmt.Errorf("unterminated SQL comment")
			}
			mask(start, i)
		case sql[i] == '\'':
			escaped := i > 0 && (sql[i-1] == 'E' || sql[i-1] == 'e')
			i++
			closed := false
			for i < len(sql) {
				if escaped && sql[i] == '\\' {
					i += 2
					continue
				}
				if sql[i] == '\'' {
					if i+1 < len(sql) && sql[i+1] == '\'' {
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				i++
			}
			if !closed {
				return "", fmt.Errorf("unterminated SQL string")
			}
			mask(start, i)
		case sql[i] == '"':
			i++
			closed := false
			for i < len(sql) {
				if sql[i] == '"' {
					if i+1 < len(sql) && sql[i+1] == '"' {
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				i++
			}
			if !closed {
				return "", fmt.Errorf("unterminated SQL identifier")
			}
		case sql[i] == '$':
			tag := dollar.FindString(sql[i:])
			if tag == "" {
				i++
				continue
			}
			end := strings.Index(sql[i+len(tag):], tag)
			if end < 0 {
				return "", fmt.Errorf("unterminated SQL dollar body")
			}
			i += len(tag) + end + len(tag)
			mask(start, i)
		default:
			i++
		}
	}
	return string(out), nil
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
	end  int
	kind string // table, index, type, other, rename, drop
	m    []string
}

func walkSchema(files []migrationFile) *schemaWalk {
	w := &schemaWalk{live: map[string]objectOwner{}, tables: map[string]string{}, indexTable: map[string]string{}}
	for _, f := range files {
		sql, err := stripSQL(f.sql)
		if err != nil {
			w.problems = append(w.problems, f.name+": "+err.Error())
			continue
		}
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
				events = append(events, schemaEvent{loc[0], loc[1], kind, m})
			}
		}
		sort.Slice(events, func(i, j int) bool { return events[i].pos < events[j].pos })
		for _, ev := range events {
			m := ev.m
			switch ev.kind {
			case "table":
				name := normIdent(m[2])
				w.create("rel", name, f.name, m[1] != "")
				if _, ok := w.tables[name]; !ok && !regexp.MustCompile(`(?i)^\s+PARTITION\s+OF\b`).MatchString(sql[ev.end:]) {
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
// planned:<ticket> owner:<engineering-owner> is the §21.3 reservation.
var plannedStatusRE = regexp.MustCompile(`^planned:(T-[A-Z0-9]+-[0-9]+[a-z]?) owner:([A-Za-z0-9][A-Za-z0-9_-]*)$`)
var migrationTicketRE = regexp.MustCompile(`(?m)^-- Ticket: (T-[A-Z0-9]+-[0-9]+[a-z]?)\s*$`)

type ownershipRow struct{ target, status, ticket string }

func readOwnership(csvPath string) (map[string]ownershipRow, []string) {
	f, err := os.Open(csvPath)
	if err != nil {
		return nil, []string{err.Error()}
	}
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	if err != nil {
		return nil, []string{fmt.Sprintf("ownership.csv unreadable: %v", err)}
	}
	if len(rows) == 0 || strings.Join(rows[0], ",") != "table,target_owner,status" {
		return nil, []string{"invalid ownership.csv header"}
	}
	owners := map[string]ownershipRow{}
	var problems []string
	for _, r := range rows[1:] {
		if len(r) != 3 || r[0] == "" || r[2] == "" {
			problems = append(problems, "invalid ownership.csv row")
			continue
		}
		if r[1] != "product" && r[1] != "private" && r[1] != "retired" {
			problems = append(problems, "unknown target owner: "+r[1])
			continue
		}
		if _, ok := owners[r[0]]; ok {
			problems = append(problems, "table "+r[0]+" is listed twice")
			continue
		}
		row := ownershipRow{target: r[1], status: r[2]}
		if strings.HasPrefix(r[2], "planned:") {
			m := plannedStatusRE.FindStringSubmatch(r[2])
			if m == nil {
				problems = append(problems, "invalid planned status: "+r[2])
				continue
			}
			row.ticket = m[1]
		}
		owners[r[0]] = row
	}
	return owners, problems
}

func checkOwnership(dir, csvPath string) []string {
	files, problems := readMigrationDir(dir)
	walk := walkSchema(files)
	live := walk.tables
	problems = append(problems, walk.problems...)
	owners, invalid := readOwnership(csvPath)
	problems = append(problems, invalid...)
	tickets := map[string]string{}
	for _, f := range files {
		matches := migrationTicketRE.FindAllStringSubmatch(f.sql, -1)
		if len(matches) > 1 {
			problems = append(problems, "ambiguous migration ticket: "+f.name)
		} else if len(matches) == 1 {
			tickets[f.name] = matches[0][1]
		}
		sql, err := stripSQL(f.sql)
		if err != nil {
			continue
		}
		names := []string{}
		for _, m := range createTableRE.FindAllStringSubmatch(sql, -1) {
			names = append(names, normIdent(m[2]))
		}
		for _, m := range renameRE.FindAllStringSubmatch(sql, -1) {
			if strings.EqualFold(m[1], "table") {
				names = append(names, normIdent(m[3]))
			}
		}
		for _, name := range names {
			row, ok := owners[name]
			if ok && row.ticket != "" && row.ticket != tickets[f.name] {
				problems = append(problems, fmt.Sprintf("table %s is reserved for %s, not migration %s ticket %q", name, row.ticket, f.name, tickets[f.name]))
			}
		}
	}

	for table, file := range live {
		switch row, ok := owners[table]; {
		case !ok:
			problems = append(problems, fmt.Sprintf("table %s (created by %s) has no row in ownership.csv", table, file))
		case row.target != "product":
			problems = append(problems, fmt.Sprintf("table %s (created by %s) is marked %q in ownership.csv", table, file, row.target))
		}
	}
	for table, row := range owners {
		if _, ok := live[table]; row.target == "product" && row.ticket == "" && !ok && !tablesCreatedByGo[table] {
			problems = append(problems, fmt.Sprintf("ownership.csv lists product table %s that no migration leaves installed", table))
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

func TestMigrationGateMigrationNamesUniqueAndGapless(t *testing.T) {
	report(t, checkMigrationNames("migrations"))
}

// Every file the embed picks up is registered, and every registered path is a
// file in the embed, in order, versions 1..N.
func checkRegistryParity(source fs.FS, registry []migrationSpec) []string {
	files, err := fs.Glob(source, "migrations/*.sql")
	if err != nil {
		return []string{err.Error()}
	}
	var problems []string
	if len(files) != len(registry) {
		problems = append(problems, fmt.Sprintf("%d embedded files, %d registry entries", len(files), len(registry)))
	}
	for i, s := range registry {
		if i >= len(files) || files[i] != s.path || s.version != i+1 {
			problems = append(problems, fmt.Sprintf("registry/embed mismatch at version %d", i+1))
		}
		m := migrationNameRE.FindStringSubmatch(path.Base(s.path))
		if m == nil {
			problems = append(problems, "invalid registry filename: "+s.path)
		} else if n, _ := strconv.Atoi(m[1]); n != s.version {
			problems = append(problems, "registry filename/version mismatch: "+s.path)
		}
	}
	return problems
}

func TestMigrationGateMigrationRegistryMatchesEmbed(t *testing.T) {
	report(t, checkRegistryParity(migrations, migrationRegistry))
	files, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	disk, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	if len(disk) != len(files) {
		t.Errorf("migrations/ holds %d entries, embed matches %d .sql files", len(disk), len(files))
	}
}

func TestMigrationGateMigrationNoDuplicateObjects(t *testing.T) {
	report(t, checkDuplicateObjects("migrations"))
}

func TestMigrationGateMigrationOwnershipExhaustive(t *testing.T) {
	report(t, checkOwnership("migrations", "../ownership.csv"))
}

// Regression: the 0104 collision. Two files with the same number both
// creating install_settings must trip the name and object checks, naming both.
func TestMigrationGateMigrationRegressionFixtureDuplicate0104(t *testing.T) {
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
func TestMigrationGateMigrationRegressionFixtureObjects(t *testing.T) {
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
