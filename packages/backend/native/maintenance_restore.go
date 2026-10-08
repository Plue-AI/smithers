package native

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/postgres"
)

// restoreAuthority is restore's offline authority (spec §16.5.3). Nothing in
// it needs a running install: it proves the install is stopped, loads the
// dump into a database the bundled initdb creates, and starts the result.
// Every step runs as the installing user, never root.
type restoreAuthority struct {
	// state is the install state root, which may not exist on another Mac.
	state string
	// postgres names the bundled PostgreSQL programs and the major they
	// report. StateDir is set per restore, inside the staging root.
	postgres postgres.Config
	// isolation proves this host runs a restored machine only inside the
	// microVM boundary (M-29). Nil refuses: there is no host fallback.
	isolation func(context.Context) error
	// start starts the install on a bundle while the recovery marker stays
	// durable and returns once it is ready. Nil refuses.
	start func(ctx context.Context, bundle string) error
}

// errInstallRunning is the refusal the CLI also gives for a loaded service.
var errInstallRunning = errors.New("install_running: restore refuses a running install; run smthrs host stop first")

// CheckStopped refuses a running install before any tree moves. The private
// socket answers only while the backend serves, and the PostgreSQL ownership
// lock is held for exactly as long as a backend owns the database.
func (a *restoreAuthority) CheckStopped(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		return errors.New("host_owner_required: maintenance requires an unprivileged installing user")
	}
	if info, err := os.Lstat(a.state); err == nil {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || stat.Uid != uint32(os.Getuid()) {
			return errors.New("host_owner_required: the install state directory belongs to another user")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	dialer := net.Dialer{Timeout: time.Second}
	if conn, err := dialer.DialContext(ctx, "unix", filepath.Join(a.state, "run/host.sock")); err == nil {
		_ = conn.Close()
		return errInstallRunning
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := postgres.Stopped(filepath.Join(a.state, "postgres")); errors.Is(err, postgres.ErrRunning) {
		return errInstallRunning
	} else if err != nil {
		return fmt.Errorf("host_maintenance_unavailable: %w", err)
	}
	return nil
}

// CheckRetainedIsolation refuses recovery on a host that cannot isolate the
// machines a backup's disks become when they wake.
func (a *restoreAuthority) CheckRetainedIsolation(ctx context.Context, _ hostbackup.Manifest) error {
	if a.isolation == nil {
		return errors.New("host_maintenance_unavailable: restore requires microVM isolation for retained machine disks")
	}
	return a.isolation(ctx)
}

// RestoreDatabase creates a database in the staging root with the bundled
// initdb of the manifest's major and loads the dump into it. The live data
// directory is never opened. The database is stopped before it returns, so
// restore can publish the staged directory as the install's own.
func (a *restoreAuthority) RestoreDatabase(ctx context.Context, stage *os.Root, dump io.Reader, version hostbackup.Version) error {
	if version.PostgresMajor != a.postgres.Major {
		return &hostbackup.Error{Code: hostbackup.WrongVersion, Path: "postgres major"}
	}
	// The packaged tools take a path. Bind it to the pinned staging root, so
	// a renamed or replaced ancestor cannot receive the database.
	directory := stage.Name()
	pinned, err := stage.Stat(".")
	if err != nil {
		return err
	}
	named, err := os.Lstat(directory)
	if err != nil || !filepath.IsAbs(directory) || !os.SameFile(pinned, named) {
		return &hostbackup.Error{Code: hostbackup.UnsafePath, Path: "restore staging"}
	}
	if _, err := stage.Lstat("postgres"); !os.IsNotExist(err) {
		return &hostbackup.Error{Code: hostbackup.UnsafePath, Path: "postgres"}
	}
	config := a.postgres
	config.StateDir = filepath.Join(directory, "postgres")
	return postgres.RestoreInto(ctx, config, dump)
}

// StartRestored starts the install on the backup's bundle when it holds one,
// otherwise on the installed bundle.
func (a *restoreAuthority) StartRestored(ctx context.Context, bundle string) error {
	if a.start == nil {
		return errors.New("host_maintenance_unavailable: restore requires the recovery start lifecycle")
	}
	return a.start(ctx, bundle)
}
