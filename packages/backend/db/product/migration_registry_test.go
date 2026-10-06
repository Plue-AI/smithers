package product

import (
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path"
	"slices"
	"strconv"
	"strings"
	"testing"
	"unicode"
)

// A SQL file under migrations/ that is missing from migrationRegistry makes
// every fresh backend refuse to start. This test needs no database, so the
// default Go target catches the drift before any PostgreSQL test runs.
func TestMigrationRegistryMatchesMigrationDirectory(t *testing.T) {
	entries, err := os.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	var onDisk []string
	for _, entry := range entries {
		if !entry.IsDir() && path.Ext(entry.Name()) == ".sql" {
			onDisk = append(onDisk, "migrations/"+entry.Name())
		}
	}
	var registered []string
	for _, spec := range migrationRegistry {
		registered = append(registered, spec.path)
	}
	for _, file := range onDisk {
		if !slices.Contains(registered, file) {
			t.Errorf("%s is not in migrationRegistry", file)
		}
	}
	for _, spec := range migrationRegistry {
		if !slices.Contains(onDisk, spec.path) {
			t.Errorf("migrationRegistry version %d names missing file %s", spec.version, spec.path)
		}
		if want, err := strconv.Atoi(strings.SplitN(path.Base(spec.path), "_", 2)[0]); err != nil || want != spec.version {
			t.Errorf("migrationRegistry version %d does not match file %s", spec.version, spec.path)
		}
	}
	loaded, err := registeredMigrations()
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded) != len(onDisk) {
		t.Fatalf("registeredMigrations loaded %d of %d SQL files", len(loaded), len(onDisk))
	}
}

// SQL is read as data. Ignore comments, string literals and dollar-quoted
// bodies; quoted identifiers retain their case. No SQL is executed by the gate.
func migrationTokens(sql string) ([]string, error) {
	var out []string
	for i := 0; i < len(sql); {
		c := sql[i]
		switch {
		case unicode.IsSpace(rune(c)):
			i++
		case strings.HasPrefix(sql[i:], "--"):
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
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
				return nil, fmt.Errorf("unterminated comment")
			}
		case c == '\'' || c == '"':
			quote := c
			i++
			var b strings.Builder
			closed := false
			for i < len(sql) {
				if sql[i] == quote {
					i++
					if i < len(sql) && sql[i] == quote {
						b.WriteByte(quote)
						i++
						continue
					}
					closed = true
					break
				}
				b.WriteByte(sql[i])
				i++
			}
			if !closed {
				return nil, fmt.Errorf("unterminated quote")
			}
			if quote == '"' {
				out = append(out, "@"+b.String())
			} else {
				out = append(out, "<literal>")
			}
		case c == '$':
			end := i + 1
			for end < len(sql) && (unicode.IsLetter(rune(sql[end])) || unicode.IsDigit(rune(sql[end])) || sql[end] == '_') {
				end++
			}
			if end < len(sql) && sql[end] == '$' {
				tag := sql[i : end+1]
				finish := strings.Index(sql[end+1:], tag)
				if finish < 0 {
					return nil, fmt.Errorf("unterminated dollar quote")
				}
				i = end + 1 + finish + len(tag)
				out = append(out, "<body>")
			} else {
				out = append(out, string(c))
				i++
			}
		case unicode.IsLetter(rune(c)) || c == '_':
			start := i
			i++
			for i < len(sql) && (unicode.IsLetter(rune(sql[i])) || unicode.IsDigit(rune(sql[i])) || sql[i] == '_' || sql[i] == '$') {
				i++
			}
			out = append(out, strings.ToLower(sql[start:i]))
		default:
			out = append(out, string(c))
			i++
		}
	}
	return out, nil
}

type tableOwnership struct{ owner, status string }

func readOwnership(r io.Reader) (map[string]tableOwnership, error) {
	rows, err := csv.NewReader(r).ReadAll()
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 || !slices.Equal(rows[0], []string{"table", "target_owner", "status"}) {
		return nil, fmt.Errorf("invalid ownership header")
	}
	result := map[string]tableOwnership{}
	for _, row := range rows[1:] {
		if len(row) != 3 || row[0] == "" || row[2] == "" || !slices.Contains([]string{"product", "private", "retired"}, row[1]) {
			return nil, fmt.Errorf("invalid ownership row %v", row)
		}
		if _, ok := result[row[0]]; ok {
			return nil, fmt.Errorf("duplicate ownership %s", row[0])
		}
		if strings.HasPrefix(row[2], "planned:") {
			parts := strings.Split(row[2], ";owner:")
			if len(parts) != 2 || strings.TrimPrefix(parts[0], "planned:") == "" || strings.TrimSpace(parts[1]) == "" {
				return nil, fmt.Errorf("planned ownership needs ticket and engineering owner: %s", row[0])
			}
		}
		result[row[0]] = tableOwnership{row[1], row[2]}
	}
	return result, nil
}

func migrationGate(files map[string]string, registry []migrationSpec, owners map[string]tableOwnership, ticket string) error {
	if len(files) != len(registry) {
		return fmt.Errorf("registry/embed count mismatch")
	}
	created := map[string]bool{}
	live := map[string]bool{}
	for index, spec := range registry {
		base := path.Base(spec.path)
		number, err := strconv.Atoi(strings.SplitN(base, "_", 2)[0])
		if err != nil || number != index+1 || spec.version != index+1 {
			return fmt.Errorf("duplicate or gap at %s", spec.path)
		}
		sql, ok := files[spec.path]
		if !ok {
			return fmt.Errorf("registry/embed mismatch: %s", spec.path)
		}
		tokens, err := migrationTokens(sql)
		if err != nil {
			return fmt.Errorf("%s: %w", spec.path, err)
		}
		for start := 0; start < len(tokens); {
			end := start
			for end < len(tokens) && tokens[end] != ";" {
				end++
			}
			stmt := tokens[start:end]
			start = end + 1
			if len(stmt) < 3 {
				continue
			}
			create := stmt[0] == "create"
			drop := stmt[0] == "drop"
			pos := 1
			if create && stmt[pos] == "unlogged" {
				pos++
			}
			if pos >= len(stmt) || stmt[pos] != "table" || (!create && !drop) {
				continue
			}
			pos++
			if pos < len(stmt) && stmt[pos] == "if" {
				if create {
					pos += 3
				} else {
					pos += 2
				}
			}
			for pos < len(stmt) {
				name := strings.TrimPrefix(stmt[pos], "@")
				pos++
				if pos+1 < len(stmt) && stmt[pos] == "." {
					name = strings.TrimPrefix(stmt[pos+1], "@")
					pos += 2
				}
				if create {
					if created[name] {
						return fmt.Errorf("duplicate CREATE TABLE %s", name)
					}
					created[name] = true
					if pos+1 < len(stmt) && stmt[pos] == "partition" && stmt[pos+1] == "of" {
						break
					}
					live[name] = true
					row, ok := owners[name]
					if ok && row.owner == "private" {
						return fmt.Errorf("private ownership for product table %s", name)
					}
					if strings.HasPrefix(row.status, "planned:") && strings.SplitN(strings.TrimPrefix(row.status, "planned:"), ";", 2)[0] != ticket {
						return fmt.Errorf("table %s planned for another ticket", name)
					}
					break
				}
				delete(live, name)
				if pos >= len(stmt) || stmt[pos] != "," {
					break
				}
				pos++
			}
		}
	}
	for name := range live {
		row, ok := owners[name]
		if !ok || row.owner != "product" {
			return fmt.Errorf("unowned product table %s", name)
		}
	}
	for name, row := range owners {
		if row.owner == "product" && !strings.HasPrefix(row.status, "planned:") && !live[name] && name != "smithers_product_migrations" {
			return fmt.Errorf("ownership retains absent or dropped table %s", name)
		}
	}
	return nil
}

func TestMigrationGate(t *testing.T) {
	files := map[string]string{}
	for _, spec := range migrationRegistry {
		b, err := migrations.ReadFile(spec.path)
		if err != nil {
			t.Fatal(err)
		}
		files[spec.path] = string(b)
	}
	f, err := os.Open("../ownership.csv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	owners, err := readOwnership(f)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrationGate(files, migrationRegistry, owners, os.Getenv("SMITHERS_MIGRATION_TICKET")); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationGateFixtures(t *testing.T) {
	for _, tc := range []struct {
		name, sql, csv, ticket string
		fail                   bool
	}{
		{"temporary table", "CREATE TEMPORARY TABLE scratch AS SELECT 1; CREATE TABLE things(id int);", "things,product,installed", "", false},
		{"unlogged", "CREATE UNLOGGED TABLE things(id int);", "things,product,installed", "", false},
		{"multiple drops", "CREATE TABLE things(id int); CREATE TABLE other(id int); DROP TABLE IF EXISTS things, public.other CASCADE;", "", "", false},
		{"quoted case", "CREATE TABLE \"Things\"(id int);", "Things,product,installed", "", false},
		{"nested comments", "/* /* CREATE TABLE bad(id int); */ */ CREATE TABLE things(id int);", "things,product,installed", "", false},
		{"string literal", "SELECT 'CREATE TABLE bad(id int); it''s hidden'; CREATE TABLE things(id int);", "things,product,installed", "", false},
		{"tagged body", "DO $body$ BEGIN CREATE TABLE hidden(id int); END $body$; CREATE TABLE things(id int);", "things,product,installed", "", false},
		{"malformed SQL", "CREATE TABLE things(id int); /* unfinished", "things,product,installed", "", true},
		{"valid", "CREATE TABLE things(id int);", "things,product,installed", "", false},
		{"duplicate", "CREATE TABLE things(id int); CREATE TABLE IF NOT EXISTS things(id int);", "things,product,installed", "", true},
		{"unowned", "CREATE TABLE things(id int);", "", "", true},
		{"planned", "CREATE TABLE things(id int);", "things,product,planned:T-TEST-01;owner:smithers-8a", "T-TEST-01", false},
		{"other ticket", "CREATE TABLE things(id int);", "things,product,planned:T-TEST-01;owner:smithers-8a", "T-TEST-02", true},
		{"dropped", "CREATE TABLE things(id int); DROP TABLE things;", "things,product,installed", "", true},
		{"removed", "CREATE TABLE things(id int); DROP TABLE things;", "", "", false},
		{"partition", "CREATE TABLE things(id int) PARTITION BY RANGE(id); CREATE TABLE child PARTITION OF things FOR VALUES FROM(0) TO(1);", "things,product,installed", "", false},
		{"duplicate partition", "CREATE TABLE things(id int) PARTITION BY RANGE(id); CREATE TABLE child PARTITION OF things FOR VALUES FROM(0) TO(1); CREATE TABLE IF NOT EXISTS child PARTITION OF things FOR VALUES FROM(1) TO(2);", "things,product,installed", "", true},
		{"missing parent", "CREATE TABLE things(id int) PARTITION BY RANGE(id); CREATE TABLE child PARTITION OF things FOR VALUES FROM(0) TO(1);", "child,product,installed", "", true},
		{"comments and bodies", "-- CREATE TABLE bad(x int);\nCREATE TABLE things(id int); DO $$ BEGIN CREATE TABLE hidden(id int); END $$; /* DROP TABLE things; */", "things,product,installed", "", false},
		{"quoted", "CREATE TABLE public.\"things\"(id int);", "things,product,installed", "", false},
		{"pending only", "SELECT 1;", "things,product,planned:T-TEST-01;owner:smithers-8a", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			owners, err := readOwnership(strings.NewReader("table,target_owner,status\n" + tc.csv + "\n"))
			if err != nil {
				t.Fatal(err)
			}
			err = migrationGate(map[string]string{"migrations/0001_fixture.sql": tc.sql}, []migrationSpec{{1, "migrations/0001_fixture.sql"}}, owners, tc.ticket)
			if (err != nil) != tc.fail {
				t.Fatalf("error=%v, want failure=%v", err, tc.fail)
			}
		})
	}
	for _, tc := range []struct {
		name     string
		registry []migrationSpec
		files    map[string]string
	}{
		{"gap", []migrationSpec{{2, "migrations/0002_x.sql"}}, map[string]string{"migrations/0002_x.sql": "SELECT 1;"}},
		{"duplicate number", []migrationSpec{{1, "migrations/0001_x.sql"}, {1, "migrations/0001_y.sql"}}, map[string]string{"migrations/0001_x.sql": "SELECT 1;", "migrations/0001_y.sql": "SELECT 1;"}},
		{"parity", []migrationSpec{{1, "migrations/0001_x.sql"}}, map[string]string{"migrations/0001_y.sql": "SELECT 1;"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := migrationGate(tc.files, tc.registry, nil, ""); err == nil {
				t.Fatal("invalid fixture accepted")
			}
		})
	}
}

func TestMigrationGateOwnershipEncoding(t *testing.T) {
	for _, input := range []string{
		"", "table,owner,status\n",
		"table,target_owner,status\nthings,unknown,installed\n",
		"table,target_owner,status\nthings,product,installed\nthings,product,installed\n",
		"table,target_owner,status\nthings,product,planned:T-TEST-01\n",
		"table,target_owner,status\nthings,product,planned:T-TEST-01;owner:\n",
		"table,target_owner,status\nthings,product,planned:;owner:smithers-8a\n",
	} {
		if _, err := readOwnership(strings.NewReader(input)); err == nil {
			t.Errorf("accepted invalid ownership %q", input)
		}
	}
	for _, sql := range []string{"SELECT 'unfinished", "CREATE TABLE \"unfinished", "DO $body$ unfinished"} {
		if _, err := migrationTokens(sql); err == nil {
			t.Errorf("accepted unterminated SQL %q", sql)
		}
	}
}
