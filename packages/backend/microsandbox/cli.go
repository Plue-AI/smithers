package microsandbox

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// RequiredVersion is the only Microsandbox release this adapter is qualified
// against. A different msb is refused rather than trusted.
const RequiredVersion = "0.6.16"

// ErrUnavailable means Microsandbox cannot run microVMs on this host. Callers
// must refuse the operation; there is no host-process fallback.
var ErrUnavailable = errors.New("microVM isolation is unavailable")

// cli runs the pinned msb binary with a scrubbed environment. Only HOME, a
// fixed PATH, and the local backend selection reach it, so ambient MSB_*
// profiles, API keys, or backend secrets cannot move work off this machine or
// leak into guest configuration.
type cli struct {
	binary string
	// home is msb's state home: where it keeps images, machines and
	// snapshots, the root filesystems guests boot.
	home string
	// verify, when set, checks binary against the installed bundle's pinned
	// manifest before every run; a refusal starts nothing.
	verify func() error
}

// runtimeCLI is the msb a runtime drives: the installed bundle's bin/msb,
// verified before every run, or Config.Binary for a runtime without one.
func runtimeCLI(config Config, msb *bundleProgram) (*cli, error) {
	if msb == nil {
		return newCLI(config.Binary)
	}
	client, err := newCLI(msb.path)
	if err != nil {
		return nil, err
	}
	client.verify = msb.check
	return client, nil
}

func newCLI(binary string) (*cli, error) {
	binary = strings.TrimSpace(binary)
	if binary == "" || !filepath.IsAbs(binary) {
		return nil, fmt.Errorf("%w: msb must be an absolute path", ErrUnavailable)
	}
	info, err := os.Stat(binary)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return nil, fmt.Errorf("%w: msb is not an executable file at %s", ErrUnavailable, binary)
	}
	home, err := accountHome()
	if err != nil {
		return nil, fmt.Errorf("%w: resolve the account home directory: %v", ErrUnavailable, err)
	}
	return &cli{binary: binary, home: home}, nil
}

// accountHome is the running account's home directory from the user
// database. The process environment's HOME never selects msb's state.
func accountHome() (string, error) {
	account, err := user.LookupId(strconv.Itoa(os.Getuid()))
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(account.HomeDir) {
		return "", fmt.Errorf("home directory %q is not absolute", account.HomeDir)
	}
	return filepath.Clean(account.HomeDir), nil
}

func (c *cli) environment() []string {
	return []string{"HOME=" + c.home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "MSB_BACKEND=local", "NO_COLOR=1"}
}

// command prepares an msb invocation. Stdin is always explicit: an inherited
// open stdin can hold an exec open indefinitely.
func (c *cli) command(args ...string) *exec.Cmd {
	// `msb exec` without --stream relays stdin so slowly that a few MiB never
	// arrive; --stream keeps stdout, stderr and the exit code separate and
	// moves ~200 MB/s. Every non-PTY exec streams.
	if len(args) > 0 && args[0] == "exec" && !containsArg(args, "--stream") && !containsArg(args, "-t") {
		args = append([]string{"exec", "--stream"}, args[1:]...)
	}
	cmd := exec.Command(c.binary, args...)
	if c.verify != nil {
		// Start returns Err without running anything, for every caller.
		if err := c.verify(); err != nil {
			cmd.Err = fmt.Errorf("%w: %w", ErrUnavailable, err)
		}
	}
	cmd.Env = c.environment()
	cmd.Stdin = bytes.NewReader(nil)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

type cliError struct {
	args     []string
	exitCode int
	stderr   string
}

func (e *cliError) Error() string {
	name := "msb"
	if len(e.args) > 0 {
		name += " " + e.args[0]
	}
	message := strings.TrimSpace(e.stderr)
	if len(message) > 600 {
		message = message[:600]
	}
	return fmt.Sprintf("%s exited %d: %s", name, e.exitCode, message)
}

func (e *cliError) notFound() bool {
	text := strings.ToLower(e.stderr)
	return strings.Contains(text, "not found") || strings.Contains(text, "no such sandbox") || strings.Contains(text, "does not exist")
}

// run executes msb to completion and returns its stdout. Cancellation kills
// the msb process group.
func (c *cli) run(ctx context.Context, stdin []byte, args ...string) ([]byte, error) {
	stdout, _, err := c.runFull(ctx, stdin, args...)
	return stdout, err
}

// runFull is run with stderr, which carries msb's human-readable reports.
func (c *cli) runFull(ctx context.Context, stdin []byte, args ...string) ([]byte, []byte, error) {
	cmd := c.command(args...)
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := startCommand(ctx, cmd); err != nil {
		return nil, nil, err
	}
	err := waitCommand(ctx, cmd)
	if ctx.Err() != nil {
		return stdout.Bytes(), stderr.Bytes(), ctx.Err()
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return stdout.Bytes(), stderr.Bytes(), &cliError{args: args, exitCode: exitErr.ExitCode(), stderr: stderr.String()}
		}
		return stdout.Bytes(), stderr.Bytes(), fmt.Errorf("msb %s: %w", strings.Join(args[:min(len(args), 2)], " "), err)
	}
	return stdout.Bytes(), stderr.Bytes(), nil
}

func (c *cli) json(ctx context.Context, into any, args ...string) error {
	output, err := c.run(ctx, nil, args...)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(output, into); err != nil {
		return fmt.Errorf("decode msb %s output: %w", args[0], err)
	}
	return nil
}

func startCommand(ctx context.Context, cmd *exec.Cmd) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start msb: %w", err)
	}
	return nil
}

// waitCommand waits for an msb child and kills its group on cancellation.
// Killing an `msb exec` client makes the guest agent end that exec session.
func waitCommand(ctx context.Context, cmd *exec.Cmd) error {
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		killGroup(cmd)
		return <-done
	}
}

func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
}

// sandboxRecord is one row of `msb list --format json`.
type sandboxRecord struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Image  string `json:"image"`
}

// snapshotRecord is one row of `msb snapshot list --format json`.
type snapshotRecord struct {
	Name         *string   `json:"name"`
	Digest       string    `json:"digest"`
	ArtifactPath string    `json:"artifact_path"`
	CreatedAt    time.Time `json:"created_at"`
	ParentDigest *string   `json:"parent_digest"`
	SizeBytes    int64     `json:"size_bytes"`
}

func (c *cli) listSandboxes(ctx context.Context, labels map[string]string) ([]sandboxRecord, error) {
	args := []string{"list", "--format", "json"}
	for key, value := range labels {
		args = append(args, "--label", key+"="+value)
	}
	var records []sandboxRecord
	if err := c.json(ctx, &records, args...); err != nil {
		return nil, err
	}
	return records, nil
}

func (c *cli) sandboxStatus(ctx context.Context, name string) (string, bool, error) {
	records, err := c.listSandboxes(ctx, nil)
	if err != nil {
		return "", false, err
	}
	for _, record := range records {
		if record.Name == name {
			return strings.ToLower(record.Status), true, nil
		}
	}
	return "", false, nil
}

func (c *cli) listSnapshots(ctx context.Context) ([]snapshotRecord, error) {
	var records []snapshotRecord
	if err := c.json(ctx, &records, "snapshot", "list", "--format", "json"); err != nil {
		return nil, err
	}
	return records, nil
}

// version returns the msb release, for example "0.6.16".
func (c *cli) version(ctx context.Context) (string, error) {
	output, err := c.run(ctx, nil, "--version")
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(output))
	if len(fields) != 2 || fields[0] != "msb" {
		return "", fmt.Errorf("unexpected msb version output %q", strings.TrimSpace(string(output)))
	}
	return fields[1], nil
}

// qualify refuses an msb that is not the pinned release, cannot find its VM
// runtime, or would select a non-local backend.
func (c *cli) qualify(ctx context.Context) error {
	version, err := c.version(ctx)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if version != RequiredVersion {
		return fmt.Errorf("%w: msb %s is installed; this backend is qualified with msb %s", ErrUnavailable, version, RequiredVersion)
	}
	stdout, stderr, err := c.runFull(ctx, nil, "doctor")
	if err != nil {
		return fmt.Errorf("%w: msb doctor failed: %v", ErrUnavailable, err)
	}
	if report := string(stdout) + string(stderr); !strings.Contains(report, "Host setup is ready") {
		return fmt.Errorf("%w: msb doctor did not report a ready host: %s", ErrUnavailable, strings.TrimSpace(report))
	}
	var context struct {
		Kind string `json:"kind"`
	}
	if err := c.json(ctx, &context, "context", "--format", "json"); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if context.Kind != "local" {
		return fmt.Errorf("%w: msb selected the %q backend; only local microVMs are allowed", ErrUnavailable, context.Kind)
	}
	return nil
}

func containsArg(args []string, flag string) bool {
	for _, arg := range args {
		if arg == "--" {
			return false
		}
		if arg == flag {
			return true
		}
	}
	return false
}

// snapshotExists reports whether Microsandbox indexes a snapshot of that name.
func (c *cli) snapshotExists(ctx context.Context, name string) (bool, error) {
	records, err := c.listSnapshots(ctx)
	if err != nil {
		return false, err
	}
	for _, record := range records {
		if record.Name != nil && *record.Name == name {
			return true, nil
		}
	}
	return false, nil
}

// removeSnapshot deletes a snapshot; one already gone is not an error.
func (c *cli) removeSnapshot(ctx context.Context, name string) error {
	if _, err := c.run(ctx, nil, "snapshot", "remove", "-q", name); err != nil {
		if exists, listErr := c.snapshotExists(ctx, name); listErr == nil && !exists {
			return nil
		}
		return fmt.Errorf("remove snapshot %s: %w", name, err)
	}
	return nil
}
