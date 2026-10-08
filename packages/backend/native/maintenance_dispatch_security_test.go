package native

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"
)

// These suites execute apps/backend/main.go, including os.Executable and the
// production dispatch, from a pinned installed bundle. They do not replace the
// doctor, grant health wake, or provide an APFS/host execution fallback. On this
// non-reference host the valid restore control reaches the real doctor and
// refuses; successful fresh/retained VM controls remain C-REL-06/C-SEC-02 work.
func installedMaintenanceCommand(t *testing.T) maintenanceBundle {
	t.Helper()
	b := newMaintenanceBundle(t, nil)
	require.NoError(t, os.Remove(b.path("bin/smithers-backend")))
	build := exec.CommandContext(t.Context(), "go", "build", "-p", "4", "-ldflags", "-X github.com/smithersai/smithers/packages/backend/internal/compose.BuildVersion=1.3.0", "-o", b.path("bin/smithers-backend"), "./apps/backend")
	build.Dir = filepath.Join("..", "..", "..")
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	require.NoError(t, os.Chmod(b.path("bin/smithers-backend"), 0755))
	// The other programs are execution canaries, not successful provider fakes.
	// A refusal must never run any of them.
	for _, program := range append([]string{"bin/smthrs"}, pgCanaries()...) {
		b.write(program, "#!/bin/sh\nprintf executed > '"+b.path("executed")+"'\nexit 97\n")
	}
	b.declare()
	return b
}

func pgCanaries() []string {
	return []string{"postgres/root/bin/postgres", "postgres/root/bin/initdb", "postgres/root/bin/pg_isready", "postgres/root/bin/psql", "postgres/root/bin/pg_dump", "postgres/root/bin/pg_restore"}
}

func runInstalledMaintenance(t *testing.T, b maintenanceBundle, home, cwd string, extra []string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, b.path("bin/smithers-backend"), append([]string{"host-maintenance"}, args...)...)
	command.Dir = cwd
	command.Env = append([]string{"HOME=" + home, "PATH=/usr/bin:/bin"}, extra...)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err := command.Run()
	var exited *exec.ExitError
	require.ErrorAs(t, err, &exited, stderr.String())
	require.Equal(t, 1, exited.ExitCode(), stderr.String())
	require.Empty(t, stdout.String(), "a refused command must print no successful result")
	require.NoFileExists(t, b.path("executed"), "no PostgreSQL or lifecycle canary ran")
	return strings.TrimSpace(stderr.String())
}

// An independent pre-operation inventory includes bytes, modes and symlink
// targets. The observed MANIFEST is never the oracle for unchanged live data.
func maintenanceInventory(t *testing.T, root string) map[string]string {
	t.Helper()
	entries := map[string]string{}
	require.NoError(t, filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		identity, ok := info.Sys().(*syscall.Stat_t)
		require.True(t, ok, "inventory must observe filesystem identity")
		value := fmt.Sprintf("%s uid=%d gid=%d dev=%d ino=%d", info.Mode(), identity.Uid, identity.Gid, identity.Dev, identity.Ino)
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			value += " -> " + target
		} else if info.Mode().IsRegular() {
			body, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			value += fmt.Sprintf(" %x", sha256.Sum256(body))
		}
		entries[relative] = value
		return nil
	}))
	return entries
}

func maintenanceSeedFile(t *testing.T, path, body string, mode os.FileMode) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0700))
	require.NoError(t, os.WriteFile(path, []byte(body), mode))
}

// Seed the accepted JSON wire format independently of manifest generation.
func maintenanceSnapshot(t *testing.T, home string, files map[string]string) (string, hostbackup.Manifest) {
	t.Helper()
	directory := filepath.Join(home, "snapshot", "1.2.3-20261007T010203.000000000Z")
	require.NoError(t, os.MkdirAll(filepath.Join(directory, "state"), 0700))
	manifest := hostbackup.Manifest{Version: "1.2.3", SchemaVersion: 2, PostgresMajor: 18, QuiesceOp: "literal-backup-op", QuiesceTime: time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC), Stack: json.RawMessage(`[]`), BranchHeads: json.RawMessage(`{}`), MachineDisks: json.RawMessage(`[]`), RunJournals: json.RawMessage(`[]`)}
	seeded := map[string]string{"postgres.dump": "PGDMP independently seeded bytes", "state/config/secrets.json": "saved key"}
	for name, body := range files {
		seeded[name] = body
	}
	for name, body := range seeded {
		maintenanceSeedFile(t, filepath.Join(directory, name), body, 0600)
		sum := sha256.Sum256([]byte(body))
		manifest.Files = append(manifest.Files, hostbackup.File{Path: name, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])})
	}
	require.NoError(t, os.Symlink("secrets.json", filepath.Join(directory, "state/config/key-link")))
	manifest.Files = append(manifest.Files, hostbackup.File{Path: "state/config/key-link", Link: "secrets.json"})
	maintenanceManifest(t, directory, manifest)
	_, err := hostbackup.VerifySnapshot(directory)
	require.NoError(t, err, "valid pre-attack control")
	return directory, manifest
}

func maintenanceManifest(t *testing.T, directory string, manifest hostbackup.Manifest) {
	t.Helper()
	raw, err := json.Marshal(manifest)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(directory, "MANIFEST.json"), raw, 0600))
}

func TestHostRestorePathConfinement(t *testing.T) {
	require.NotZero(t, os.Geteuid(), "never execute branch-built code as root")
	bundle := installedMaintenanceCommand(t)
	for _, name := range []string{"absolute entry", "traversal entry", "unclean entry", "absolute link", "traversal link", "link chain", "replaced ancestor", "replaced snapshot", "replaced state tree", "replaced dump", "replaced manifest", "link loop", "cross-tree link", "directory dump", "directory manifest", "fifo dump", "fifo manifest", "missing manifest", "changed dump", "windows entry", "nul entry"} {
		t.Run(name, func(t *testing.T) {
			home, state := ownerHome(t)
			outside := filepath.Join(home, "outside")
			maintenanceSeedFile(t, filepath.Join(outside, "sentinel"), "outside bytes", 0640)
			maintenanceSeedFile(t, filepath.Join(state, "config/secrets.json"), "live key", 0600)
			maintenanceSeedFile(t, filepath.Join(state, "postgres/data/live"), "live database", 0600)
			backup, manifest := maintenanceSnapshot(t, home, map[string]string{"state/workspaces/ancestor/seed": "retained bytes"})
			refusal := ""
			link := "state/workspaces/escape"
			target := ""
			switch name {
			case "windows entry":
				manifest.Files[0].Path = `C:\outside\sentinel`
				refusal = `unsafe_path: C:\outside\sentinel`
			case "nul entry":
				manifest.Files[0].Path = "state/config/secret\x00suffix"
				refusal = "unsafe_path: state/config/secret\x00suffix"
			case "directory manifest", "fifo manifest":
				refusal = "unsafe_path: MANIFEST.json"
			case "missing manifest":
				refusal = "missing_file: MANIFEST.json"
			case "changed dump":
				maintenanceSeedFile(t, filepath.Join(backup, "postgres.dump"), "PGDMP independently seeded byteX", 0600)
				refusal = "hash_mismatch: postgres.dump"
			case "directory dump":
				require.NoError(t, os.Remove(filepath.Join(backup, "postgres.dump")))
				require.NoError(t, os.Mkdir(filepath.Join(backup, "postgres.dump"), 0700))
				refusal = "missing_file: postgres.dump"
			case "fifo dump":
				require.NoError(t, os.Remove(filepath.Join(backup, "postgres.dump")))
				require.NoError(t, unix.Mkfifo(filepath.Join(backup, "postgres.dump"), 0600))
				refusal = "unsafe_path: postgres.dump"
			case "cross-tree link":
				maintenanceSeedFile(t, filepath.Join(backup, "bundle/bin/payload"), "branch executable bytes", 0755)
				sum := sha256.Sum256([]byte("branch executable bytes"))
				manifest.Files = append(manifest.Files, hostbackup.File{Path: "bundle/bin/payload", Size: 23, SHA256: hex.EncodeToString(sum[:])})
				target = "../../bundle/bin/payload"
			case "absolute entry":
				manifest.Files[0].Path = filepath.Join(outside, "sentinel")
				refusal = "unsafe_path: " + manifest.Files[0].Path
			case "traversal entry":
				manifest.Files[0].Path = "../outside/sentinel"
				refusal = "unsafe_path: ../outside/sentinel"
			case "unclean entry":
				manifest.Files[0].Path = "state/../outside/sentinel"
				refusal = "unsafe_path: state/../outside/sentinel"
			case "absolute link":
				target = outside
			case "traversal link":
				target, _ = filepath.Rel(filepath.Join(backup, "state/workspaces"), outside)
			case "link chain":
				target = "hop"
				relative, err := filepath.Rel(filepath.Join(backup, "state/workspaces"), outside)
				require.NoError(t, err)
				require.NoError(t, os.Symlink(relative, filepath.Join(backup, "state/workspaces/hop")))
				manifest.Files = append(manifest.Files, hostbackup.File{Path: "state/workspaces/hop", Link: relative})
			case "replaced ancestor":
				require.NoError(t, os.Rename(filepath.Join(backup, "state/workspaces/ancestor"), filepath.Join(home, "retained-ancestor")))
				require.NoError(t, os.Symlink(outside, filepath.Join(backup, "state/workspaces/ancestor")))
				refusal = "unsafe_path: state/workspaces/ancestor"
			case "replaced snapshot":
				moved := filepath.Join(home, "retained-snapshot")
				require.NoError(t, os.Rename(backup, moved))
				require.NoError(t, os.Symlink(moved, backup))
				refusal = "unsafe_path: " + backup
			case "replaced state tree":
				require.NoError(t, os.Rename(filepath.Join(backup, "state"), filepath.Join(home, "retained-state")))
				require.NoError(t, os.Symlink(filepath.Join(home, "retained-state"), filepath.Join(backup, "state")))
				refusal = "unsafe_path: state"
			case "replaced dump":
				require.NoError(t, os.Remove(filepath.Join(backup, "postgres.dump")))
				require.NoError(t, os.Symlink(filepath.Join(outside, "sentinel"), filepath.Join(backup, "postgres.dump")))
				refusal = "unsafe_path: postgres.dump"
			case "replaced manifest":
				refusal = "unsafe_path: MANIFEST.json"
			case "link loop":
				target = "escape"
			}
			if target != "" {
				require.NoError(t, os.Symlink(target, filepath.Join(backup, link)))
				manifest.Files = append(manifest.Files, hostbackup.File{Path: link, Link: target})
				refusal = "unsafe_path: " + link
			}
			maintenanceManifest(t, backup, manifest)
			if name == "replaced manifest" {
				require.NoError(t, os.Rename(filepath.Join(backup, "MANIFEST.json"), filepath.Join(outside, "manifest")))
				require.NoError(t, os.Symlink(filepath.Join(outside, "manifest"), filepath.Join(backup, "MANIFEST.json")))
			}
			switch name {
			case "directory manifest":
				require.NoError(t, os.Remove(filepath.Join(backup, "MANIFEST.json")))
				require.NoError(t, os.Mkdir(filepath.Join(backup, "MANIFEST.json"), 0700))
			case "fifo manifest":
				require.NoError(t, os.Remove(filepath.Join(backup, "MANIFEST.json")))
				require.NoError(t, unix.Mkfifo(filepath.Join(backup, "MANIFEST.json"), 0600))
			case "missing manifest":
				require.NoError(t, os.Remove(filepath.Join(backup, "MANIFEST.json")))
			}
			before := maintenanceInventory(t, home)
			require.Equal(t, refusal, runInstalledMaintenance(t, bundle, home, home, nil, "restore", backup))
			require.Equal(t, before, maintenanceInventory(t, home), "restore refused before moving live data or writing outside")
		})
	}
}

func TestHostMaintenanceIsolationAndRootInputs(t *testing.T) {
	require.NotZero(t, os.Geteuid(), "never execute branch-built code as root")
	bundle := installedMaintenanceCommand(t)
	database := testdb.New(t)
	pool, err := postgresfixture.Open(t.Context(), database.URL, 4)
	require.NoError(t, err)
	t.Cleanup(pool.Close)
	require.NoError(t, product.Apply(t.Context(), pool))
	queries := db.New(pool)
	owner, err := queries.CreateUser(t.Context(), db.CreateUserParams{Username: "isolationowner", LowerUsername: "isolationowner"})
	require.NoError(t, err)
	_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	t.Logf("production backend pid authority: uid=%d gid=%d; no root execution", os.Geteuid(), os.Getegid())
	for _, payload := range []struct{ name, body string }{
		{"hostile retained environment", `{"PATH":"/workspace/bin","PYTHONPATH":"/workspace/imports","LD_PRELOAD":"/workspace/inject.so"}`},
		{"traversal session", `{"id":"../../outside","user":"root","argv":["/workspace/hook"],"cwd":"/outside"}`},
		{"malformed envelope", `{"id":`},
		{"hostile cgroup", `{"id":"literal","user":"root","cgroup":"../../outside","uid":0,"gid":0}`},
	} {
		t.Run(payload.name, func(t *testing.T) {
			home, state := ownerHome(t)
			outside := filepath.Join(home, "outside")
			maintenanceSeedFile(t, filepath.Join(outside, "sentinel"), "outside bytes", 0640)
			maintenanceSeedFile(t, filepath.Join(state, "config/secrets.json"), "live key", 0600)
			repository := filepath.Join(home, "repository")
			canary := filepath.Join(outside, "executed")
			script := "#!/bin/sh\nprintf hostile > '" + canary + "'\nexit 98\n"
			for _, name := range []string{".git/hooks/pre-commit", ".git/hooks/post-checkout", "bin/brew", "bin/pg_dump", "bin/python3", "bin/smithers-backend"} {
				maintenanceSeedFile(t, filepath.Join(repository, name), script, 0755)
			}
			maintenanceSeedFile(t, filepath.Join(repository, "imports/sitecustomize.py"), "open('"+canary+"','w').write('imported')", 0600)
			backup, manifest := maintenanceSnapshot(t, home, map[string]string{"state/microvm/disks/retained": "opaque retained disk bytes", "state/requests/session.json": payload.body})
			// A retained home symlink outside STATE is rejected before any doctor.
			require.NoError(t, os.MkdirAll(filepath.Join(backup, "state/homes/member"), 0700))
			require.NoError(t, os.Symlink(outside, filepath.Join(backup, "state/homes/member/.config")))
			manifest.Files = append(manifest.Files, hostbackup.File{Path: "state/homes/member/.config", Link: outside})
			maintenanceManifest(t, backup, manifest)
			extra := []string{"PATH=" + filepath.Join(repository, "bin") + ":/usr/bin:/bin", "PYTHONPATH=" + filepath.Join(repository, "imports"), "GIT_SSH_COMMAND=" + filepath.Join(repository, "bin/brew"), "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0=core.hooksPath", "GIT_CONFIG_VALUE_0=" + filepath.Join(repository, ".git/hooks"), "SMITHERS_MSB_PATH=" + filepath.Join(repository, "bin/smithers-backend"), "SMITHERS_DATABASE_URL=postgres://attacker.invalid/db", "DYLD_INSERT_LIBRARIES=" + filepath.Join(repository, "inject.dylib")}
			service := services.NewInstallQuiesce(&services.QuiesceGate{Store: services.InstallQuiesceStore{Pool: pool}, StateDir: state})
			handler := &routes.InstallQuiesceHandler{Owners: queries, Service: service}
			closeSocket, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(handler.HandleInstallingOwner))
			require.NoError(t, err)
			socketClosed := false
			t.Cleanup(func() {
				if !socketClosed {
					require.NoError(t, closeSocket())
				}
			})
			before := maintenanceInventory(t, home)
			require.Equal(t, "unsafe_path: state/homes/member/.config", runInstalledMaintenance(t, bundle, home, repository, extra, "restore", backup))
			require.Equal(t, before, maintenanceInventory(t, home))
			require.Equal(t, "host_maintenance_unavailable: quiesce unavailable: T-MCH-07 required\nquiesce unavailable: T-MCH-06 required\nquiesce unavailable: T-FLW-01 required\nquiesce unavailable: T-STK-04 required\nquiesce unavailable: T-COL-08 required\nquiesce unavailable: T-COL-09 required\nquiesce unavailable: T-GH-09 required\nquiesce unavailable: T-TRM-07 required\nquiesce unavailable: T-SEC-01 required\nowned postgres maintenance unavailable\nbackup summary authority unavailable", runInstalledMaintenance(t, bundle, home, repository, extra, "backup"))
			require.Equal(t, before, maintenanceInventory(t, home))
			require.Equal(t, "host_maintenance_unavailable: maintenance health wake unavailable", runInstalledMaintenance(t, bundle, home, repository, extra, "upgrade"))
			require.Equal(t, before, maintenanceInventory(t, home))
			// Valid confined retained-home control reaches the actual bundled doctor;
			// unavailable isolation still refuses before staging or PostgreSQL.
			require.NoError(t, os.Remove(filepath.Join(backup, "state/homes/member/.config")))
			manifest.Files = manifest.Files[:len(manifest.Files)-1]
			maintenanceManifest(t, backup, manifest)
			before = maintenanceInventory(t, home)
			require.Equal(t, "install_running: restore refuses a running install; run smthrs host stop first", runInstalledMaintenance(t, bundle, home, repository, extra, "restore", backup))
			require.Equal(t, before, maintenanceInventory(t, home))
			require.NoError(t, closeSocket())
			socketClosed = true
			before = maintenanceInventory(t, home)
			require.Equal(t, "host_maintenance_unavailable: microVM isolation is not ready on this Mac; run smthrs host status", runInstalledMaintenance(t, bundle, home, repository, extra, "restore", backup))
			require.Equal(t, before, maintenanceInventory(t, home))
			require.NoFileExists(t, canary)
			var freezes int
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
			require.Zero(t, freezes, "unavailable health wake must refuse before freezing")
			var username string
			require.NoError(t, pool.QueryRow(t.Context(), `SELECT username FROM users WHERE id=$1`, owner.ID).Scan(&username))
			require.Equal(t, "isolationowner", username)
		})
	}
	for _, member := range pgCanaries() {
		t.Run("replaced bundled executable/"+member, func(t *testing.T) {
			home, state := ownerHome(t)
			maintenanceSeedFile(t, filepath.Join(state, "config/secrets.json"), "live key", 0600)
			backup, _ := maintenanceSnapshot(t, home, nil)
			program := bundle.path(member)
			approved, err := os.ReadFile(program)
			require.NoError(t, err)
			t.Cleanup(func() { require.NoError(t, os.WriteFile(program, approved, 0755)) })
			// Do not rewrite the pinned approval when the branch replaces a file.
			maintenanceSeedFile(t, program, "#!/bin/sh\nprintf hostile > '"+filepath.Join(home, "executed")+"'\n", 0755)
			before := maintenanceInventory(t, home)
			require.Equal(t, "host_maintenance_unavailable: restore runs from an installed bundle: postgres/bundle.json: not approved by the installed bundle: "+member+" differs from the bundle manifest", runInstalledMaintenance(t, bundle, home, home, nil, "restore", backup))
			require.Equal(t, before, maintenanceInventory(t, home))
		})
	}
	t.Run("health continuation rejects backup outside recovery tree", func(t *testing.T) {
		home, state := ownerHome(t)
		backup, _ := maintenanceSnapshot(t, home, nil)
		maintenanceSeedFile(t, filepath.Join(state, ".upgrade-incomplete"), backup+"\n", 0600)
		before := maintenanceInventory(t, home)
		require.Equal(t, "upgrade incomplete: lstat "+filepath.Join(state, "backups")+": no such file or directory; restore with smthrs host restore '"+backup+"'", runInstalledMaintenance(t, bundle, home, home, []string{"PYTHONPATH=/hostile", "GIT_SSH_COMMAND=/hostile"}, "upgrade-continue", backup))
		require.Equal(t, before, maintenanceInventory(t, home))
		require.NoFileExists(t, filepath.Join(state, recoveryGrantPath))
	})
	t.Run("health continuation rejects replaced lifecycle", func(t *testing.T) {
		home, state := ownerHome(t)
		source, _ := maintenanceSnapshot(t, home, nil)
		require.NoError(t, os.Mkdir(filepath.Join(state, "backups"), 0700))
		backup := filepath.Join(state, "backups", filepath.Base(source))
		require.NoError(t, os.Rename(source, backup))
		maintenanceSeedFile(t, filepath.Join(state, ".upgrade-incomplete"), backup+"\n", 0600)
		program := bundle.path("bin/smthrs")
		approved, err := os.ReadFile(program)
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, os.WriteFile(program, approved, 0755)) })
		maintenanceSeedFile(t, program, "#!/bin/sh\nprintf hostile > '"+filepath.Join(home, "executed")+"'\n", 0755)
		before := maintenanceInventory(t, home)
		require.Equal(t, "upgrade incomplete: host_maintenance_unavailable: not approved by the installed bundle: bin/smthrs differs from the bundle manifest; restore with smthrs host restore '"+backup+"'", runInstalledMaintenance(t, bundle, home, home, []string{"PATH=/hostile", "PYTHONPATH=/hostile"}, "upgrade-continue", backup))
		require.Equal(t, before, maintenanceInventory(t, home))
		require.NoFileExists(t, filepath.Join(state, recoveryGrantPath))
	})
	t.Run("backup through composed owner socket", func(t *testing.T) {
		database := testdb.New(t)
		pool, err := postgresfixture.Open(t.Context(), database.URL, 4)
		require.NoError(t, err)
		t.Cleanup(pool.Close)
		require.NoError(t, product.Apply(t.Context(), pool))
		queries := db.New(pool)
		owner, err := queries.CreateUser(t.Context(), db.CreateUserParams{Username: "maintenanceowner", LowerUsername: "maintenanceowner"})
		require.NoError(t, err)
		_, err = pool.Exec(t.Context(), `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
		require.NoError(t, err)
		home, state := ownerHome(t)
		maintenanceSeedFile(t, filepath.Join(state, "config/secrets.json"), "live key", 0600)
		service := services.NewInstallQuiesce(&services.QuiesceGate{Store: services.InstallQuiesceStore{Pool: pool}, StateDir: state})
		handler := &routes.InstallQuiesceHandler{Owners: queries, Service: service}
		closeSocket, err := services.StartInstallSetupHandoff(t.Context(), state, func(context.Context, io.Writer) error { return nil }, http.HandlerFunc(handler.HandleInstallingOwner))
		require.NoError(t, err)
		t.Cleanup(func() { require.NoError(t, closeSocket()) })
		before := maintenanceInventory(t, home)
		refusal := runInstalledMaintenance(t, bundle, home, home, []string{"PYTHONPATH=/hostile", "GIT_SSH_COMMAND=/hostile", "SMITHERS_MSB_PATH=/hostile"}, "backup")
		require.Equal(t, "host_maintenance_unavailable: quiesce unavailable: T-MCH-07 required\nquiesce unavailable: T-MCH-06 required\nquiesce unavailable: T-FLW-01 required\nquiesce unavailable: T-STK-04 required\nquiesce unavailable: T-COL-08 required\nquiesce unavailable: T-COL-09 required\nquiesce unavailable: T-GH-09 required\nquiesce unavailable: T-TRM-07 required\nquiesce unavailable: T-SEC-01 required\nowned postgres maintenance unavailable\nbackup summary authority unavailable", refusal)
		require.Equal(t, before, maintenanceInventory(t, home))
		var freezes int
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT count(*) FROM install_settings WHERE key='quiesce'`).Scan(&freezes))
		require.Zero(t, freezes)
		var name string
		require.NoError(t, pool.QueryRow(t.Context(), `SELECT username FROM users WHERE id=$1`, owner.ID).Scan(&name))
		require.Equal(t, "maintenanceowner", name)
	})
}
