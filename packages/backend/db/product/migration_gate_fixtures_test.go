package product

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

// Literal oracles: spec.md §21.3 / C-PRC-02 steps 2–3. Planned encoding
// preserves target_owner and names exactly one ticket and engineering owner.
func TestMigrationGateOwnershipFixtures(t *testing.T) {
	for _, tc := range []struct{ name, sql, rows, want string }{
		{"reservation", "-- Ticket: T-FIX-01\nCREATE TABLE widget (id int);", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", ""},
		{"other ticket", "-- Ticket: T-FIX-02\nCREATE TABLE widget (id int);", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", "reserved for T-FIX-01"},
		{"create drop other ticket", "-- Ticket: T-FIX-02\nCREATE TABLE widget (id int); DROP TABLE widget;", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", "reserved for T-FIX-01"},
		{"rename other ticket", "-- Ticket: T-FIX-02\nCREATE TABLE staging (id int); ALTER TABLE staging RENAME TO widget;", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", "reserved for T-FIX-01"},
		{"rename drop other ticket", "-- Ticket: T-FIX-02\nCREATE TABLE staging (id int); ALTER TABLE staging RENAME TO widget; DROP TABLE widget;", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", "reserved for T-FIX-01"},
		{"rename matching ticket", "-- Ticket: T-FIX-01\nCREATE TABLE staging (id int); ALTER TABLE staging RENAME TO widget;", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", ""},
		{"missing ticket", "CREATE TABLE widget (id int);", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", "reserved for T-FIX-01"},
		{"missing owner", "CREATE TABLE widget (id int);", "widget,product,planned:T-FIX-01\n", "invalid planned status"},
		{"unused reservation", "SELECT 1;", "widget,product,planned:T-FIX-01 owner:smithers-8a\n", ""},
		{"unowned", "CREATE TABLE widget (id int);", "other,private,private schema\n", "has no row"},
		{"dropped", "CREATE TABLE widget (id int); DROP TABLE widget;", "widget,product,installed\n", "no migration leaves installed"},
		{"partition", "CREATE TABLE parent (id int) PARTITION BY RANGE (id); CREATE TABLE child PARTITION OF parent FOR VALUES FROM (0) TO (10);", "parent,product,installed\n", ""},
		{"parent unowned", "CREATE TABLE parent (id int) PARTITION BY RANGE (id); CREATE TABLE child PARTITION OF parent FOR VALUES FROM (0) TO (10);", "other,private,private schema\n", "parent"},
		{"duplicate CSV", "SELECT 1;", "widget,product,installed\nwidget,private,private schema\n", "listed twice"},
		{"bad header", "SELECT 1;", "", "header"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			os.WriteFile(filepath.Join(dir, "0001_fixture.sql"), []byte(tc.sql), 0600)
			csvPath := filepath.Join(t.TempDir(), "ownership.csv")
			csv := "table,target_owner,status\n" + tc.rows
			if tc.name == "bad header" {
				csv = "wrong,header,names\n"
			}
			os.WriteFile(csvPath, []byte(csv), 0600)
			got := strings.Join(checkOwnership(dir, csvPath), "\n")
			if tc.want == "" && got != "" {
				t.Fatal(got)
			}
			if tc.want != "" && !strings.Contains(got, tc.want) {
				t.Fatalf("want %q, got %q", tc.want, got)
			}
		})
	}
}

// SQL is data (§21.3): comment syntax inside literals cannot hide later DDL;
// nested comments and dollar bodies cannot invent DDL. Quoted names retain case.
func TestMigrationGateSQLLexicalFixtures(t *testing.T) {
	for _, tc := range []struct {
		name, sql string
		want      []string
	}{
		{"literal comment", "SELECT '--'; CREATE TABLE visible (id int);", []string{"visible"}},
		{"literal block", "SELECT '/*'; CREATE TABLE visible (id int); SELECT '*/';", []string{"visible"}},
		{"nested comment", "/* outer /* inner */ CREATE TABLE hidden (id int); */ CREATE TABLE visible (id int);", []string{"visible"}},
		{"dollar tags", "$outer$ $inner$ CREATE TABLE hidden (id int); $inner$ $outer$; CREATE TABLE visible (id int);", []string{"visible"}},
		{"schema whitespace", "CREATE TABLE public . visible (id int);", []string{"visible"}},
		{"quoted schema", `CREATE TABLE "public"."Visible" (id int); CREATE TABLE visible (id int);`, []string{"Visible", "visible"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := walkSchema([]migrationFile{{"0001_fixture.sql", 1, tc.sql}})
			if len(got.tables) != len(tc.want) {
				t.Fatalf("tables: %v, want %v", got.tables, tc.want)
			}
			for _, name := range tc.want {
				if _, ok := got.tables[name]; !ok {
					t.Errorf("missing %s in %v", name, got.tables)
				}
			}
		})
	}
}

func TestMigrationGateNumberFixtures(t *testing.T) {
	// Literal sequence and errors: §21.3; no historical gaps are exempt.
	for _, tc := range []struct {
		name  string
		files []string
		want  string
	}{
		{"dense", []string{"0001_a.sql", "0002_b.sql"}, ""},
		{"gap", []string{"0001_a.sql", "0003_b.sql"}, "gap: no migration numbered 0002"},
		{"duplicate", []string{"0001_a.sql", "0001_b.sql"}, "duplicate migration number 0001"},
		{"zero", []string{"0000_a.sql"}, "must start at 0001"},
		{"malformed", []string{"1_a.sql"}, "does not match"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			for _, name := range tc.files {
				os.WriteFile(filepath.Join(dir, name), []byte("SELECT 1;"), 0600)
			}
			got := strings.Join(checkMigrationNames(dir), "\n")
			if tc.want == "" && got != "" || tc.want != "" && !strings.Contains(got, tc.want) {
				t.Fatalf("want %q, got %q", tc.want, got)
			}
		})
	}
}

func TestMigrationGateRegistryFixtures(t *testing.T) {
	// Literal oracles from §21.3, independent of the registry under test.
	files := fstest.MapFS{"migrations/0001_a.sql": &fstest.MapFile{Data: []byte("SELECT 1;")}, "migrations/0002_b.sql": &fstest.MapFile{Data: []byte("SELECT 2;")}}
	for _, tc := range []struct {
		name     string
		registry []migrationSpec
		valid    bool
	}{
		{"parity", []migrationSpec{{1, "migrations/0001_a.sql"}, {2, "migrations/0002_b.sql"}}, true},
		{"missing", []migrationSpec{{1, "migrations/0001_a.sql"}}, false},
		{"extra", []migrationSpec{{1, "migrations/0001_a.sql"}, {2, "migrations/0002_b.sql"}, {3, "migrations/0003_c.sql"}}, false},
		{"wrong path", []migrationSpec{{1, "migrations/0001_a.sql"}, {2, "migrations/0002_c.sql"}}, false},
		{"wrong number", []migrationSpec{{1, "migrations/0001_a.sql"}, {3, "migrations/0002_b.sql"}}, false},
		{"short name", []migrationSpec{{1, "a"}}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := checkRegistryParity(files, tc.registry)
			if (len(got) == 0) != tc.valid {
				t.Fatalf("valid=%v: %v", tc.valid, got)
			}
		})
	}
}

func TestMigrationGateOwnershipInstalledRows(t *testing.T) {
	owners := installedOwnershipRows(map[string]ownershipRow{
		"existing": {target: "product", status: "installed"},
		"future":   {target: "product", status: "planned:T-FIX-01 owner:smithers-8a", ticket: "T-FIX-01"},
		"private":  {target: "private", status: "private schema"},
	})
	// §21.3: planned never passes the installed table's product-owner assertion,
	// and never enters the reverse product-inventory parity assertion.
	if owners["existing"] != "product" || owners["future"] != "planned" || owners["private"] != "private" {
		t.Fatal(owners)
	}
}

func TestMigrationGateMalformedSQLFixtures(t *testing.T) {
	for _, sql := range []string{"/* unclosed", "SELECT 'unclosed", `CREATE TABLE "unclosed`, "DO $tag$ unclosed"} {
		t.Run(sql, func(t *testing.T) {
			if got := walkSchema([]migrationFile{{"0001_bad.sql", 1, sql}}); len(got.problems) == 0 {
				t.Fatalf("accepted malformed SQL %q", sql)
			}
		})
	}
}
