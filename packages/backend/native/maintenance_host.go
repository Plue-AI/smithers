package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/postgres"
)

// Bundle members a maintenance command runs. Each is verified against the
// pinned manifest immediately before it is executed.
const (
	bundleCLI     = "bin/smthrs"
	bundlePGIndex = "postgres/bundle.json"
)

// postgresPrograms are the PostgreSQL programs a restore runs.
var postgresPrograms = []string{"postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"}

// maintenanceHost is the installed bundle a maintenance command runs from,
// pinned once, and the only programs it starts: that bundle's own. Nothing is
// found through PATH, the working directory or the caller's environment, and
// every child runs as the installing user with an inert environment.
type maintenanceHost struct {
	bundle *installbundle.Bundle
	state  string
	// run executes one program and reports its exit status. Tests replace it.
	run func(ctx context.Context, program string, args, env []string) (int, error)
}

// openMaintenanceHost pins the bundle the running backend belongs to. A
// development build, or a backend copied out of its bundle, has none.
func openMaintenanceHost(executable func() (string, error), state string) (*maintenanceHost, error) {
	if executable == nil {
		return nil, errors.New("the backend executable is unknown")
	}
	program, err := executable()
	if err != nil {
		return nil, fmt.Errorf("locate the backend executable: %w", err)
	}
	bundle, err := installbundle.OpenRunning(program)
	if err != nil {
		return nil, err
	}
	return &maintenanceHost{bundle: bundle, state: state, run: runBundled}, nil
}

// runBundled runs a child with exactly env. Its output is discarded: a
// maintenance command's own standard output is its result, and a child's
// text may hold terminal escapes or setup URLs.
func runBundled(ctx context.Context, program string, args, env []string) (int, error) {
	command := exec.CommandContext(ctx, program, args...)
	command.Env, command.Stdin, command.Stdout, command.Stderr = env, nil, io.Discard, io.Discard
	command.WaitDelay = 5 * time.Second
	err := command.Run()
	var exited *exec.ExitError
	if errors.As(err, &exited) && exited.ExitCode() >= 0 {
		return exited.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// environment is what every child inherits: the installing user's home and
// the bundle's own programs ahead of the system's. No SMITHERS_*, loader,
// git or provider variable crosses.
func (h *maintenanceHost) environment(extra ...string) ([]string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return append([]string{"HOME=" + home, "PATH=" + h.bundle.Path("bin") + ":/usr/bin:/bin:/usr/sbin:/sbin"}, extra...), nil
}

// program verifies one bundle member's bytes and answers its host path.
func (h *maintenanceHost) program(relative string) (string, error) {
	file := h.bundle.Program(relative)
	if err := file.Check(); err != nil {
		return "", err
	}
	return file.Path(), nil
}

// postgres answers the bundle's PostgreSQL programs. postgres/bundle.json
// names their directory inside the bundle, as the launcher reads it.
func (h *maintenanceHost) postgres() (postgres.Config, error) {
	raw, _, err := h.bundle.Read(bundlePGIndex, 4096)
	if err != nil {
		return postgres.Config{}, err
	}
	var index struct {
		Version int    `json:"version"`
		Bin     string `json:"bin"`
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&index); err != nil || index.Version != 1 || index.Bin == "" || path.IsAbs(index.Bin) || path.Clean(index.Bin) != index.Bin || strings.HasPrefix(index.Bin, "../") || index.Bin == ".." {
		return postgres.Config{}, fmt.Errorf("%w: %s is invalid", installbundle.ErrUnapproved, bundlePGIndex)
	}
	directory, err := h.bundle.ExpectPrograms(bundlePGIndex, h.bundle.Path(path.Join("postgres", index.Bin)), postgresPrograms...)
	if err != nil {
		return postgres.Config{}, err
	}
	return postgres.Config{BinDir: directory, Major: 18}, nil
}

// isolation runs the bundle's own `microvm doctor`, the check `smthrs host
// status` runs. A host that cannot isolate machines never receives restored
// machine disks: there is no host fallback (M-29).
func (h *maintenanceHost) isolation(ctx context.Context) error {
	backend, err := h.program(installbundle.BackendPath)
	if err != nil {
		return fmt.Errorf("host_maintenance_unavailable: %w", err)
	}
	env, err := h.environment("SMITHERS_DATA_ROOT=" + h.state)
	if err != nil {
		return err
	}
	bounded, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	status, err := h.run(bounded, backend, []string{"microvm", "doctor"}, env)
	if err := ctx.Err(); err != nil {
		return err
	}
	if err != nil || status != 0 {
		return errors.New("host_maintenance_unavailable: microVM isolation is not ready on this Mac; run smthrs host status")
	}
	return nil
}

// recoveryStartLimit bounds a start. It covers a first boot's migrations on a
// loaded Mac; `smthrs host start` itself fails sooner when startup stalls.
const recoveryStartLimit = 15 * time.Minute

// start answers restore's start step for backup. It grants this process's
// operation a start while the marker is durable, runs the bundle's
// `smthrs host start --bundle` (T-INS-08) and waits until the install is
// ready. target is the bundle to start: the one the backup held, restored
// into the install state, or this bundle when it held none.
func (h *maintenanceHost) start(backup string) func(context.Context, string) error {
	return func(ctx context.Context, target string) (err error) {
		if target == "" {
			target = h.bundle.Root()
		}
		cli, err := h.program(bundleCLI)
		if err != nil {
			return fmt.Errorf("host_maintenance_unavailable: %w", err)
		}
		env, err := h.environment()
		if err != nil {
			return err
		}
		revoke, err := grantRecoveryStart(h.state, backup)
		if err != nil {
			return err
		}
		// The grant never outlives this step: once it returns, a start is
		// ordinary again and the marker alone decides.
		defer func() { err = errors.Join(err, revoke()) }()
		bounded, cancel := context.WithTimeout(ctx, recoveryStartLimit)
		defer cancel()
		status, runErr := h.run(bounded, cli, []string{"host", "start", "--bundle", target}, env)
		if err := ctx.Err(); err != nil {
			return err
		}
		// `smthrs host start` exits 0 with setup URLs, or 3 once the install
		// is already claimed. Both mean it started and answered ready.
		if runErr != nil || (status != 0 && status != 3) {
			return fmt.Errorf("host_start_failed: the restored install did not start on %s; run smthrs host start --bundle %s for the reason", target, shellArg(target))
		}
		return nil
	}
}
