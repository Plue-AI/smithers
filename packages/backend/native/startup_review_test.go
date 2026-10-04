package native

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/app"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/postgres"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

func TestNativeStartupAdoptsBinaryVersion(t *testing.T) {
	bin, major := testdb.Tools(t)
	files, err := filepath.Glob("../db/product/migrations/*.sql")
	if err != nil || len(files) == 0 {
		t.Fatalf("migration files: %v", err)
	}
	head, err := strconv.Atoi(filepath.Base(files[len(files)-1])[:4])
	if err != nil {
		t.Fatal(err)
	}
	previous := compose.BuildVersion
	compose.BuildVersion = "1.3.0"
	t.Cleanup(func() { compose.BuildVersion = previous })
	for _, name := range []string{"fresh", "existing below", "existing head", "existing newer", "bundle mismatch", "bundle file mismatch", "existing forward", "existing downgrade", "existing same below", "existing dev state", "existing dev binary", "existing postgres mismatch"} {
		t.Run(name, func(t *testing.T) {
			compose.BuildVersion = "1.3.0"
			if name == "existing downgrade" {
				compose.BuildVersion = "1.2.3"
			}
			if name == "existing dev state" {
				compose.BuildVersion = "1.0.0"
			}
			if name == "existing dev binary" {
				compose.BuildVersion = "dev"
			}
			root := t.TempDir()
			cfg := Config{StateDir: root, Postgres: postgres.Config{BinDir: bin, Major: major, StateDir: filepath.Join(root, "postgres"), StartupTimeout: 20 * time.Second}}
			var output bytes.Buffer
			cfg.App = app.Config{Args: []string{"migrate", "status"}, Stdout: &output, Stderr: &output}
			if strings.HasPrefix(name, "existing") {
				p, err := postgres.Start(t.Context(), cfg.Postgres)
				if err != nil {
					t.Fatal(err)
				}
				pool, err := pgxpool.New(t.Context(), p.ConnectionString)
				if err != nil {
					_ = stop(p, 15*time.Second)
					t.Fatal(err)
				}
				if name == "existing head" || name == "existing newer" {
					err = app.Migrate(t.Context(), p.ConnectionString)
					if err == nil && name == "existing newer" {
						_, err = pool.Exec(t.Context(), `INSERT INTO smithers_product_migrations(version,checksum) VALUES ($1,'future')`, head+1)
					}
				} else {
					body, readErr := os.ReadFile(files[0])
					if readErr != nil {
						pool.Close()
						_ = stop(p, 15*time.Second)
						t.Fatal(readErr)
					}
					tx, beginErr := pool.Begin(t.Context())
					if beginErr != nil {
						pool.Close()
						_ = stop(p, 15*time.Second)
						t.Fatal(beginErr)
					}
					_, err = tx.Exec(t.Context(), string(body), pgx.QueryExecModeSimpleProtocol)
					if err == nil {
						_, err = tx.Exec(t.Context(), `CREATE TABLE smithers_product_migrations(version integer PRIMARY KEY, checksum text NOT NULL); CREATE TABLE adoption_proof(value text); INSERT INTO adoption_proof VALUES ('keep')`)
					}
					if err == nil {
						_, err = tx.Exec(t.Context(), `INSERT INTO smithers_product_migrations VALUES (1,$1)`, fmt.Sprintf("%x", sha256.Sum256(body)))
					}
					if err == nil {
						err = tx.Commit(t.Context())
					} else {
						_ = tx.Rollback(t.Context())
					}
				}
				pool.Close()
				stopErr := stop(p, 15*time.Second)
				if err != nil || stopErr != nil {
					t.Fatal(errors.Join(err, stopErr))
				}
				put(t, filepath.Join(root, "repositories", "proof"), "keep")
			}
			if strings.HasPrefix(name, "existing") && name != "existing below" && name != "existing head" && name != "existing newer" {
				state := Version{"1.2.3", "1", fmt.Sprint(major)}
				switch name {
				case "existing downgrade":
					state.Version = "1.3.0"
				case "existing same below":
					state.Version = compose.BuildVersion
				case "existing dev state":
					state.Version = "dev"
				case "existing dev binary":
					state.Version = "1.0.0"
				case "existing postgres mismatch":
					state.Postgres = fmt.Sprint(major + 1)
				}
				if err := WriteVersion(root, state); err != nil {
					t.Fatal(err)
				}
			}
			if name == "bundle mismatch" {
				cfg.Release = Version{"wrong", fmt.Sprint(head), fmt.Sprint(major)}
			}
			if name == "bundle file mismatch" {
				executable, err := os.Executable()
				if err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(filepath.Dir(executable), "version.env")
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("test bundle path already exists: %v", err)
				}
				put(t, path, fixtureVersionText(Version{"wrong", fmt.Sprint(head), fmt.Sprint(major)}))
				t.Cleanup(func() {
					if err := os.Remove(path); err != nil {
						t.Error(err)
					}
				})
			}
			err = Run(context.Background(), cfg)
			if name == "bundle mismatch" || name == "bundle file mismatch" {
				if err == nil || !strings.Contains(err.Error(), "binary") {
					t.Fatalf("bundle disagreement: %v", err)
				}
			} else if name == "existing postgres mismatch" {
				if err == nil || !strings.Contains(err.Error(), "PostgreSQL") {
					t.Fatalf("PG refusal: %v", err)
				}
			} else if name == "existing newer" || name == "existing downgrade" {
				if err == nil || !strings.Contains(err.Error(), "smthrs host restore") || !strings.Contains(err.Error(), "newer") {
					t.Fatalf("downgrade refusal: %v", err)
				}
			} else {
				if err != nil {
					t.Fatal(err)
				}
				got, err := ReadVersion(filepath.Join(root, "version.env"))
				want := Version{compose.BuildVersion, fmt.Sprint(head), fmt.Sprint(major)}
				if err != nil || got != want {
					t.Fatalf("manifest: %+v, want %+v: %v", got, want, err)
				}
				info, statErr := os.Stat(filepath.Join(root, "version.env"))
				if statErr != nil || info.Mode().Perm() != 0600 {
					t.Fatalf("manifest mode: %v %v", info, statErr)
				}
				if output.String() != "applied\n" {
					t.Fatalf("app did not start with migrated database: %q", output.String())
				}
				if name == "existing below" || name == "existing forward" || name == "existing same below" || name == "existing dev state" || name == "existing dev binary" {
					p, err := postgres.Start(t.Context(), cfg.Postgres)
					if err != nil {
						t.Fatal(err)
					}
					pool, err := pgxpool.New(t.Context(), p.ConnectionString)
					if err != nil {
						_ = stop(p, 15*time.Second)
						t.Fatal(err)
					}
					var value string
					err = pool.QueryRow(t.Context(), `SELECT value FROM adoption_proof`).Scan(&value)
					pool.Close()
					stopErr := stop(p, 15*time.Second)
					if err != nil || stopErr != nil || value != "keep" {
						t.Fatalf("existing rows: %q %v", value, errors.Join(err, stopErr))
					}
				}
				if strings.HasPrefix(name, "existing") {
					body, err := os.ReadFile(filepath.Join(root, "repositories", "proof"))
					if err != nil || string(body) != "keep" {
						t.Fatalf("existing files: %q %v", body, err)
					}
				}
				return
			}
			if name == "existing downgrade" || name == "existing postgres mismatch" {
				got, readErr := ReadVersion(filepath.Join(root, "version.env"))
				if readErr != nil || got.Version == compose.BuildVersion {
					t.Fatalf("refusal changed manifest: %+v %v", got, readErr)
				}
				return
			}
			if _, err := os.Stat(filepath.Join(root, "version.env")); !os.IsNotExist(err) {
				t.Fatal("refusal published state manifest")
			}
		})
	}
}

func TestNativeStopBudgetRealPostgres(t *testing.T) {
	bin, major := testdb.Tools(t)
	for _, budget := range []time.Duration{0, 8 * time.Second} {
		t.Run(budget.String(), func(t *testing.T) {
			database, err := postgres.Start(t.Context(), postgres.Config{BinDir: bin, Major: major, StateDir: filepath.Join(t.TempDir(), "postgres")})
			if err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			if err := stop(database, budget); err != nil {
				t.Fatal(err)
			}
			select {
			case <-database.Done():
			default:
				t.Fatal("PostgreSQL survived stop")
			}
			limit := budget
			if limit == 0 {
				limit = 15 * time.Second
			}
			if time.Since(started) >= limit {
				t.Fatalf("PostgreSQL stop exceeded %s", limit)
			}
		})
	}
}

// A stopped child cannot handle PostgreSQL's graceful signals. The caller's
// deadline still bounds escalation, including the forced process-group stop.
func TestNativeStopBudgetBoundsUnresponsivePostgres(t *testing.T) {
	bin, major := testdb.Tools(t)
	root := filepath.Join(t.TempDir(), "postgres")
	database, err := postgres.Start(t.Context(), postgres.Config{BinDir: bin, Major: major, StateDir: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Stop(context.Background()) })
	// postmaster.pid is owned by this fixture; never inspect a system server.
	files, err := filepath.Glob(filepath.Join(root, "*", "postmaster.pid"))
	if err != nil || len(files) != 1 {
		t.Fatalf("postmaster pid: %v %v", files, err)
	}
	contents, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.Fields(string(contents))[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := syscall.Kill(pid, syscall.SIGSTOP); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	err = stop(database, 300*time.Millisecond)
	if err == nil {
		t.Fatal("an unresponsive child should report forced shutdown")
	}
	if time.Since(started) >= time.Second {
		t.Fatal("PostgreSQL exceeded the caller's stop budget")
	}
	select {
	case <-database.Done():
	default:
		t.Fatal("PostgreSQL survived forced stop")
	}
}
