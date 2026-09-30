package postgres

import (
	"bufio"
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
)

func testConfig(t *testing.T) Config {
	t.Helper()
	bin, major := testdb.Tools(t)
	return Config{BinDir: bin, StateDir: t.TempDir(), Major: major, StartupTimeout: 20 * time.Second}
}

func stopInstance(t *testing.T, instance *Instance) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := instance.Stop(ctx); err != nil {
		t.Fatal(err)
	}
}

func query(t *testing.T, bin string, instance *Instance, sql string) string {
	t.Helper()
	u, err := url.Parse(instance.ConnectionString)
	if err != nil {
		t.Fatal(err)
	}
	password, _ := u.User.Password()
	cmd := exec.Command(filepath.Join(bin, "psql"), "-h", u.Hostname(), "-p", u.Port(), "-U", u.User.Username(), "-d", "postgres", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql)
	cmd.Env = append(childEnvironment(), "PGPASSWORD="+password)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("query failed: %v: %s", err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestMissingConfiguration(t *testing.T) {
	for _, cfg := range []Config{{}, {BinDir: "bin", StateDir: "state", Major: 9}} {
		if _, err := Start(context.Background(), cfg); err == nil {
			t.Fatalf("accepted invalid config: %+v", cfg)
		}
	}
}

func TestRealLifecyclePersistsAndRefusesUpgrade(t *testing.T) {
	cfg := testConfig(t)
	first, err := Start(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	query(t, cfg.BinDir, first, "CREATE TABLE lifecycle_proof (value text); INSERT INTO lifecycle_proof VALUES ('survived')")
	if other, err := Start(context.Background(), cfg); err == nil {
		_ = other.Stop(context.Background())
		t.Fatal("second owner admitted")
	}
	stopInstance(t, first)
	second, err := Start(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got := query(t, cfg.BinDir, second, "SELECT value FROM lifecycle_proof"); got != "survived" {
		t.Fatalf("lost data: %q", got)
	}
	stopInstance(t, second)
	versionPath := filepath.Join(cfg.StateDir, "data", "PG_VERSION")
	original, err := os.ReadFile(versionPath)
	if err != nil {
		t.Fatal(err)
	}
	wrong := "17\n"
	if strings.TrimSpace(string(original)) == "17" {
		wrong = "16\n"
	}
	if err := os.WriteFile(versionPath, []byte(wrong), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Start(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "explicit upgrade") {
		t.Fatalf("accepted incompatible data: %v", err)
	}
	if bytes, _ := os.ReadFile(versionPath); string(bytes) != wrong {
		t.Fatal("rewrote incompatible data")
	}
}

func TestRealCredentialRecoveryRefusals(t *testing.T) {
	mutations := map[string]func(string) error{
		"missing": os.Remove,
		"corrupt": func(path string) error { return os.WriteFile(path, []byte("not-a-secret"), 0600) },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			cfg := testConfig(t)
			instance, err := Start(context.Background(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			stopInstance(t, instance)
			if err := mutate(filepath.Join(cfg.StateDir, "password")); err != nil {
				t.Fatal(err)
			}
			if _, err := Start(context.Background(), cfg); err == nil || !strings.Contains(err.Error(), "credential") {
				t.Fatalf("accepted %s credential: %v", name, err)
			}
		})
	}
}

func TestRealCrashIsObservable(t *testing.T) {
	cfg := testConfig(t)
	instance, err := Start(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := instance.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-instance.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("postmaster death was not observable")
	}
	if instance.Err() == nil {
		t.Fatal("crashed postmaster reported a clean exit")
	}
	instance.release()
}

func TestCrashHelper(t *testing.T) {
	if os.Getenv("SMITHERS_POSTGRES_CRASH_HELPER") != "1" {
		return
	}
	major, _ := strconv.Atoi(os.Getenv(testdb.ToolsMajorEnv))
	cfg := Config{BinDir: os.Getenv(testdb.ToolsEnv), StateDir: os.Getenv("SMITHERS_POSTGRES_CRASH_STATE"), Major: major, StartupTimeout: 20 * time.Second}
	if _, err := Start(context.Background(), cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	fmt.Println("POSTGRES_READY")
	_ = os.Stdout.Sync()
	select {}
}

func TestRealOrphanRecoveryAfterSupervisorSIGKILL(t *testing.T) {
	cfg := testConfig(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashHelper$")
	cmd.Env = append(os.Environ(), "SMITHERS_POSTGRES_CRASH_HELPER=1", "SMITHERS_POSTGRES_CRASH_STATE="+cfg.StateDir,
		testdb.ToolsMajorEnv+"="+strconv.Itoa(cfg.Major))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	ready := make(chan bool, 1)
	go func() {
		for scanner.Scan() {
			if scanner.Text() == "POSTGRES_READY" {
				ready <- true
				return
			}
		}
		ready <- false
	}()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("crash helper exited before readiness")
		}
	case <-time.After(30 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("crash helper did not become ready")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	recovered, err := Start(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	query(t, cfg.BinDir, recovered, "SELECT 1")
	stopInstance(t, recovered)
}

func TestRefusesToSignalUnverifiedLivePID(t *testing.T) {
	state := t.TempDir()
	data := filepath.Join(state, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	pid := os.Getpid()
	pidFile := fmt.Sprintf("%d\n%s\n0\n5432\n\n127.0.0.1\n0\nready\n", pid, data)
	if err := os.WriteFile(filepath.Join(data, "postmaster.pid"), []byte(pidFile), 0600); err != nil {
		t.Fatal(err)
	}
	record := fmt.Sprintf(`{"pid":%d,"data_dir":%q,"executable":%q,"birth":"wrong"}`, pid, data, os.Args[0])
	recordPath := filepath.Join(state, "postmaster.owner.json")
	if err := os.WriteFile(recordPath, []byte(record), 0600); err != nil {
		t.Fatal(err)
	}
	if err := reclaimOrphan(context.Background(), recordPath, data, os.Args[0]); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("accepted unverified PID: %v", err)
	}
}

func TestInitializationFailureNeverPublishesPartialData(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("Unix-only")
	}
	root := t.TempDir()
	bin, state := filepath.Join(root, "bin"), filepath.Join(root, "state")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(state, 0700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nmkdir -p \"$2\"\nprintf '18\\n' > \"$2/PG_VERSION\"\nsleep 30\n"
	if err := os.WriteFile(filepath.Join(bin, "initdb"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	password := filepath.Join(state, "password")
	if err := os.WriteFile(password, []byte(strings.Repeat("a", 64)), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	err := initialize(ctx, Config{BinDir: bin, StateDir: state, StartupTimeout: 100 * time.Millisecond}, filepath.Join(state, "data"), password, os.Stderr)
	if err == nil {
		t.Fatal("timed-out initdb succeeded")
	}
	if _, err := os.Stat(filepath.Join(state, "data")); !os.IsNotExist(err) {
		t.Fatal("partial data directory was published")
	}
	matches, _ := filepath.Glob(filepath.Join(state, "data.init-*"))
	if len(matches) != 0 {
		t.Fatalf("staging leaked: %v", matches)
	}
}

func TestPartialDataIsPreserved(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(data, "partial")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := validateDataDirectory(data, 18); err == nil || !strings.Contains(err.Error(), "nonempty") {
		t.Fatalf("accepted ambiguous data: %v", err)
	}
	if bytes, _ := os.ReadFile(marker); string(bytes) != "keep" {
		t.Fatal("deleted partial data")
	}
}
