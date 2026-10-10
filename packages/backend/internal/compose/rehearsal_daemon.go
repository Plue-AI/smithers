package compose

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// rehearsalLifecycle owns fixture processes and scratch directories. Production
// installs never select this adapter; the trusted-process test backend does.
type rehearsalLifecycle interface {
	Helper()
	TempDir() string
	Cleanup(func())
	Context() context.Context
	Logf(string, ...any)
}

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
func startRehearsalMachined(t rehearsalLifecycle, ctx context.Context, registry *machined.Registry, branch, root, evidence, binary string, item *machined.ItemBinding, retirement ...func(func())) (result error) {
	return startRehearsalMachinedWith(t, ctx, registry, branch, root, evidence, binary, item, nil, retirement...)
}

// Retain the guest's private state and authenticated boot across a daemon kill.
// These options are test-only; the default rehearsal remains a single boot.
type rehearsalRestart struct {
	State, Run, KillAt string
	// Attach lets a separately supervised host own the actual relay connection.
	// The daemon remains owned and reaped by this test, including on host exit.
	Attach func(context.Context, string) error
	// HostHead comes from the production machineBranchHead provider.
	HostHead string
	// Transfer uses the install's production object transport before wake.
	// Standalone native fixtures already share their exact repository.
	Transfer bool
	Conflict *machined.RetainedConflict
	Exited   chan error
}

func startRehearsalMachinedWith(t rehearsalLifecycle, ctx context.Context, registry *machined.Registry, branch, root, evidence, binary string, item *machined.ItemBinding, restart *rehearsalRestart, retirement ...func(func())) (result error) {
	t.Helper()
	if binary == "" {
		return fmt.Errorf("SMITHERS_REHEARSAL_MACHINED_BINARY must name the rehearsal_daemon example")
	}
	binary, err := filepath.Abs(binary)
	if err != nil {
		return err
	}
	state, run := "", ""
	if restart != nil {
		state, run = restart.State, restart.Run
	}
	if state == "" {
		state = t.TempDir()
	}
	if run == "" {
		run = t.TempDir()
	}
	if err = os.Chmod(state, 0700); err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Join(run, "machined"), 0700); err != nil {
		return err
	}
	bootPath := filepath.Join(run, "machined", "boot")
	if _, statErr := os.Stat(bootPath); os.IsNotExist(statErr) {
		authority, mintErr := registry.MintBoot(branch, branch)
		if mintErr != nil {
			return mintErr
		}
		bootFile := authority.File(0)
		if item != nil {
			bootFile, err = authority.FileForItem(0, *item)
			if err != nil {
				return err
			}
		}
		if err = os.WriteFile(bootPath, bootFile, 0400); err != nil {
			return err
		}
	} else if statErr != nil {
		return statErr
	}
	command := exec.Command("bwrap", "--tmpfs", "/", "--ro-bind", "/usr", "/usr", "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "--symlink", "usr/bin", "/bin", "--ro-bind", "/etc", "/etc", "--proc", "/proc", "--dev", "/dev", "--ro-bind", binary, binary, "--unshare-user", "--uid", "19998", "--gid", "19998", "--die-with-parent", "--bind", root, root, "--bind", root, "/workspace", "--tmpfs", "/var/lib", "--bind", state, "/var/lib/smithers-machined", "--tmpfs", "/run", "--bind", run, "/run/smithers", "--chdir", "/workspace", "--", binary)
	command.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	if restart != nil && restart.KillAt != "" {
		command.Env = append(command.Env, "SMITHERS_MACHINED_KILL_AT="+restart.KillAt)
	}
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
	go func() {
		err := command.Wait()
		if restart != nil && restart.Exited != nil {
			restart.Exited <- err
		}
		done <- err
	}()
	var stopOnce sync.Once
	stop := func() { stopOnce.Do(func() { _ = command.Process.Kill(); <-done; _ = log.Close() }) }
	t.Cleanup(stop)
	defer func() {
		if result != nil {
			stop()
		}
	}()
	for _, register := range retirement {
		register(stop)
	}
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
	if restart != nil && restart.Attach != nil {
		return restart.Attach(ctx, address)
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
	var head []byte
	if restart != nil && restart.HostHead != "" {
		head = []byte(restart.HostHead)
	} else {
		jj, err := rehearsalJJBinary(os.Getenv("PATH"))
		if err != nil {
			return err
		}
		headCommand := exec.CommandContext(ctx, jj, "log", "-r", "@", "--no-graph", "-T", "commit_id")
		headCommand.Dir = root
		head, err = headCommand.Output()
		if err != nil {
			return err
		}
	}
	headBytes, err := hex.DecodeString(strings.TrimSpace(string(head)))
	if err != nil || len(headBytes) != 20 {
		return fmt.Errorf("invalid rehearsal head: %q", head)
	}
	// The daemon and host already share this exact repository. No object transfer
	// fixture or synthetic readiness receipt substitutes for native reconciliation.
	if restart != nil && (restart.Conflict != nil || restart.Transfer) {
		return registry.AdmitReady(ctx, branch, hex.EncodeToString(headBytes), nil, restart.Conflict)
	}
	reply, err := link.Request(ctx, branch, wire.WakeReconcile, wire.Field(1, headBytes))
	if err != nil {
		return fmt.Errorf("wake reconcile request: %w", err)
	}
	fields, err := wire.Fields("response", reply.Payload[1:])
	if err != nil || len(fields[2]) == 0 || fields[2][0] == 255 {
		return fmt.Errorf("machined reconciliation refused: %x (%v)", reply.Payload, err)
	}
	// Roster is part of the handshake; the ordinary registry RPC correctly
	// refuses until this exact wake and roster have been acknowledged.
	if _, err = link.Request(ctx, branch, wire.SetRoster, wire.Field(1, wire.U16(0))); err != nil {
		return fmt.Errorf("set startup roster: %w", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		reply, err = link.Request(ctx, branch, wire.Status)
		if err != nil {
			return fmt.Errorf("startup status: %w", err)
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
