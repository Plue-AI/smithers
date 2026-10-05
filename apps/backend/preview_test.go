//go:build smithers_preview

package main

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/testkit/testdb"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPreviewOffOpensNoControlRuntime(t *testing.T) {
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "off")
	mode, err := workspaceIsolation(false)
	if err != nil || mode != "off" {
		t.Fatalf("preview off = %q, %v", mode, err)
	}
	runtimes, err := openExecutionRuntimes(context.Background(), t.TempDir(), "", false)
	if err != nil {
		t.Fatal(err)
	}
	if runtimes.control != nil || runtimes.relay != nil || runtimes.workspace.Isolation() != workspaceapi.IsolationDisabled {
		t.Fatalf("unexpected preview runtimes: %+v", runtimes)
	}
	if err := runtimes.Close(); err != nil {
		t.Fatal(err)
	}
}

// Re-exec the actual entry point so SIGTERM reaches the signal handler and
// both the owned PostgreSQL child and backend must stop before Cloud Run kills.
func TestPreviewSignalHelper(t *testing.T) {
	if os.Getenv("SMITHERS_PREVIEW_SIGNAL_TEST") != "1" {
		return
	}
	os.Args = []string{os.Args[0]}
	main()
}

func TestPreviewNativeSIGTERM(t *testing.T) {
	if os.Getenv("SMITHERS_FFI_LIBRARY_PATH") == "" {
		t.Skip("requires built smithers-ffi library")
	}
	bin, major := testdb.Tools(t)
	if major != 18 {
		t.Skip("requires PostgreSQL 18")
	}
	root, _ := serveFixture(t)
	t.Setenv("SMITHERS_WORKSPACE_ISOLATION", "off")
	t.Setenv("SMITHERS_NATIVE_POSTGRES_BIN", bin)
	t.Setenv("SMITHERS_NATIVE_STATE_DIR", root)
	t.Setenv("SMITHERS_MODEL_HOST_BUNDLE", "")
	t.Setenv("SMITHERS_NODE_BINARY", "")
	t.Setenv("SMITHERS_DATABASE_URL", "")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()
	t.Setenv("SMITHERS_SERVER_ADDR", address)
	t.Setenv("SMITHERS_PUBLIC_URL", "http://"+address)
	t.Setenv("SMITHERS_PREVIEW_SIGNAL_TEST", "1")
	web := t.TempDir()
	if err := os.WriteFile(filepath.Join(web, "index.html"), []byte("<html>preview</html>"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SMITHERS_WEB_ROOT", web)
	command := exec.Command(os.Args[0], "-test.run=^TestPreviewSignalHelper$")
	logPath := filepath.Join(t.TempDir(), "backend.log")
	log, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	command.Stdout = log
	command.Stderr = log
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Kill() })
	client := &http.Client{Timeout: time.Second}
	ready := false
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		response, err := client.Get("http://" + address + "/api/bootstrap")
		if err == nil {
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			if response.StatusCode == 200 {
				if !strings.Contains(string(body), `"install"`) {
					t.Fatal(string(body))
				}
				ready = true
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !ready {
		body, _ := os.ReadFile(logPath)
		t.Fatalf("preview did not start: %s", body)
	}
	// Invalid model-host inputs did not prevent startup. There is no chat host.
	response, err := client.Get("http://" + address + "/")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("app: %d", response.StatusCode)
	}
	children, err := exec.Command("pgrep", "-P", strconv.Itoa(command.Process.Pid)).Output()
	if err != nil {
		t.Fatal(err)
	}
	pids := strings.Fields(string(children))
	if len(pids) != 1 {
		t.Fatalf("preview children = %v; expected PostgreSQL only", pids)
	}
	started := time.Now()
	if err := command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			body, _ := os.ReadFile(logPath)
			t.Fatalf("preview shutdown: %v\n%s", err, body)
		}
	case <-time.After(nativeStopBudget() + localShutdownBudget()):
		t.Fatal("preview exceeded its 8s stop budget")
	}
	if time.Since(started) >= nativeStopBudget()+localShutdownBudget() {
		t.Fatal("preview stop exceeded 8s")
	}
	for _, raw := range pids {
		pid, _ := strconv.Atoi(raw)
		if err := syscall.Kill(pid, 0); err != syscall.ESRCH {
			t.Fatalf("PostgreSQL child %d survived: %v", pid, err)
		}
	}
	if nativeStopBudget()+localShutdownBudget() >= 10*time.Second {
		t.Fatal("preview shutdown exceeds Cloud Run grace")
	}
}
