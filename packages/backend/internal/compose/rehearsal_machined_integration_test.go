package compose

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

// Preserve the actual challenge bytes while waiting for provider initialization.
// Registry.Connect still enforces the ordinary five-second authentication bound.
type rehearsalReadyConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c rehearsalReadyConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

// The installed daemon runs unchanged as UID 19998 in an unprivileged mount
// namespace. Only the broker's empty session census is a fixture. Agent/local
// writes and personal terminals still require the real guest session broker.
func startRehearsalMachined(t *testing.T, ctx context.Context, registry *machined.Registry, branch, root, evidence, binary string, item *machined.ItemBinding) (result error) {
	t.Helper()
	if binary == "" {
		return fmt.Errorf("SMITHERS_REHEARSAL_MACHINED_BINARY must name the rehearsal_daemon example")
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		return err
	}
	state := t.TempDir()
	run := t.TempDir()
	if err = os.Chmod(state, 0700); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(run, "machined"), 0700); err != nil {
		return err
	}
	authority, err := registry.MintBoot(branch, branch)
	if err != nil {
		return err
	}
	bootFile := authority.File(0)
	if item != nil {
		bootFile, err = authority.FileForItem(0, *item)
		if err != nil {
			return err
		}
	}
	if err = os.WriteFile(filepath.Join(run, "machined", "boot"), bootFile, 0400); err != nil {
		return err
	}
	command := exec.Command("bwrap", "--tmpfs", "/", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev", "--ro-bind", binary, binary, "--unshare-user", "--uid", "19998", "--gid", "19998", "--die-with-parent", "--bind", root, root, "--bind", root, "/workspace", "--tmpfs", "/var/lib", "--bind", state, "/var/lib/smithers-machined", "--tmpfs", "/run", "--bind", run, "/run/smithers", "--chdir", "/workspace", "--", binary)
	command.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return err
	}
	log, err := os.OpenFile(filepath.Join(evidence, "machined-"+branch+".log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	command.Stderr = log
	defer func() {
		if result != nil {
			data, _ := os.ReadFile(log.Name())
			result = fmt.Errorf("%w; daemon: %s", result, data)
		}
	}()
	if err = command.Start(); err != nil {
		log.Close()
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	t.Cleanup(func() { _ = command.Process.Kill(); <-done; _ = log.Close() })
	scanner := bufio.NewScanner(stdout)
	ready := make(chan string, 1)
	go func() {
		if scanner.Scan() {
			ready <- scanner.Text()
		} else {
			ready <- ""
		}
		_, _ = io.Copy(log, stdout)
	}()
	var address string
	select {
	case port := <-ready:
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			data, _ := os.ReadFile(log.Name())
			return fmt.Errorf("machined did not publish its relay port: %q: %s", port, data)
		}
		address = net.JoinHostPort("127.0.0.1", port)
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(30 * time.Second):
		return fmt.Errorf("machined startup timeout")
	}
	stream, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		return err
	}
	if err = stream.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		stream.Close()
		return err
	}
	reader := bufio.NewReader(stream)
	if _, err = reader.Peek(1); err != nil {
		stream.Close()
		data, _ := os.ReadFile(log.Name())
		return fmt.Errorf("machined provider startup: %w: %s", err, data)
	}
	link, err := registry.Connect(ctx, branch, rehearsalReadyConn{stream, reader})
	if err != nil {
		data, _ := os.ReadFile(log.Name())
		return fmt.Errorf("machined connect: %w: %s", err, data)
	}
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	if err != nil {
		return err
	}
	headCommand := exec.CommandContext(ctx, jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
	headCommand.Dir = root
	head, err := headCommand.Output()
	if err != nil {
		return err
	}
	headBytes, err := hex.DecodeString(strings.TrimSpace(string(head)))
	if err != nil || len(headBytes) != 20 {
		return fmt.Errorf("invalid rehearsal head: %q", head)
	}
	// The daemon and host already share this exact repository. No object transfer
	// fixture or synthetic readiness receipt substitutes for native reconciliation.
	reply, err := link.Request(ctx, branch, wire.WakeReconcile, wire.Field(1, headBytes))
	if err != nil {
		return err
	}
	fields, err := wire.Fields("response", reply.Payload[1:])
	if err != nil || len(fields[2]) == 0 || fields[2][0] == 255 {
		return fmt.Errorf("machined reconciliation refused: %x (%v)", reply.Payload, err)
	}
	// Roster is part of the handshake; the ordinary registry RPC correctly
	// refuses until this exact wake and roster have been acknowledged.
	if _, err = link.Request(ctx, branch, wire.SetRoster, wire.Field(1, wire.U16(0))); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		reply, err = link.Request(ctx, branch, wire.Status)
		if err != nil {
			return err
		}
		fields, err = wire.Fields("response", reply.Payload[1:])
		if err != nil || len(fields[2]) == 0 || fields[2][0] != byte(wire.Status) {
			return fmt.Errorf("machined status refused")
		}
		status, err := wire.Fields("result1", fields[2][1:])
		if err != nil {
			return err
		}
		if len(status[1]) == 1 && status[1][0] == 3 {
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("machined is not ready after event drain: %x", fields[2])
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	return link.Reconciled()
}

func TestRehearsalMachinedNativeFilesystem(t *testing.T) {
	binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY")
	if binary == "" {
		t.Skip("requires the real rehearsal_daemon binary and Linux user namespaces")
	}
	root := t.TempDir()
	jj, err := rehearsalJJBinary(os.Getenv("PATH"))
	require.NoError(t, err)
	init := exec.Command(jj, "git", "init", root)
	output, err := init.CombinedOutput()
	require.NoError(t, err, string(output))
	const branch = "731f7b03-e381-4af6-b744-16e26f1f327e"
	hostRepo := t.TempDir()
	hostInit := exec.Command("/usr/bin/git", "init", "--bare", hostRepo)
	output, err = hostInit.CombinedOutput()
	require.NoError(t, err, string(output))
	registry := new(machined.Registry)
	registry.BindObjectImporter(machined.GitBundleImporter(func(_ context.Context, id string) (string, error) {
		if id != branch {
			return "", machined.ErrUnauthorized
		}
		return hostRepo, nil
	}))
	t.Cleanup(func() { require.NoError(t, registry.Close()) })
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	require.NoError(t, startRehearsalMachined(t, ctx, registry, branch, root, t.TempDir(), binary, &machined.ItemBinding{}))
	require.NoError(t, os.WriteFile(filepath.Join(root, "outside.txt"), []byte("outside\n"), 0600))
	file, err := registry.ReadFile(ctx, branch, "outside.txt", "")
	require.NoError(t, err)
	require.Equal(t, []byte("outside\n"), file.Content)
	_, err = registry.ReadFile(ctx, branch, "../etc/passwd", "")
	require.Error(t, err)
	watchCtx, stopWatch := context.WithTimeout(ctx, 15*time.Second)
	defer stopWatch()
	var event machined.Event
	for event.Seq == 0 {
		event, err = registry.Events(branch).Receive(watchCtx)
		require.NoError(t, err)
	}
	burst, err := wire.DecodeBurst(event.Payload)
	require.NoError(t, err)
	require.Equal(t, byte(4), burst.Actor.Kind, "unregistered host writes are outside changes")
	require.Len(t, burst.Files, 1)
	require.Equal(t, "outside.txt", burst.Files[0].Path)
	require.Equal(t, "added", burst.Files[0].Change)
	sum := sha256.Sum256([]byte("outside\n"))
	require.Equal(t, hex.EncodeToString(sum[:]), burst.Files[0].PostDigest)
	missing, err := (machined.GitBurstObjects{Resolve: func(context.Context, string) (string, error) { return hostRepo, nil }}).VerifyBurst(ctx, branch, burst)
	require.NoError(t, err)
	require.Empty(t, missing, "the real daemon transferred all retained outside-change objects")

}

// The example is never part of an install bundle or run by root. Build from
// this lane, matching the other rehearsal hosts, unless a binary is explicit.
func buildRehearsalMachined(t *testing.T, root string) string {
	t.Helper()
	if binary := os.Getenv("SMITHERS_REHEARSAL_MACHINED_BINARY"); binary != "" {
		return binary
	}
	target := filepath.Join(root, ".artifacts", "rehearsal-machined")
	build := exec.Command("cargo", "build", "--locked", "-p", "smithers-machined", "--example", "rehearsal_daemon", "--target-dir", target)
	build.Dir = root
	output, err := build.CombinedOutput()
	require.NoError(t, err, string(output))
	return filepath.Join(target, "debug", "examples", "rehearsal_daemon")
}
