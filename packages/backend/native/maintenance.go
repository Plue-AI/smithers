package native

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
)

// DispatchMaintenance is server-free: refusals cannot bootstrap PostgreSQL,
// migrate state, acquire a freeze or launch a repository runtime. The install
// refuses missing coordinated capture/drain; the CLI uses the private owner socket.
// executable answers the running backend's path (os.Executable): restore runs
// only programs of the installed bundle that backend belongs to.
func DispatchMaintenance(ctx context.Context, args []string, executable func() (string, error)) (bool, error) {
	if len(args) == 0 || args[0] != "host-maintenance" {
		return false, nil
	}
	if err := ctx.Err(); err != nil {
		return true, err
	}
	if os.Geteuid() == 0 {
		return true, errors.New("host_owner_required: maintenance requires an unprivileged installing user")
	}
	if len(args) < 2 {
		return true, errors.New("invalid_command: expected backup, upgrade or restore <directory>")
	}
	switch args[1] {
	case "backup", "upgrade":
		if len(args) != 2 {
			return true, errors.New("invalid_command: backup and upgrade accept no arguments")
		}
	case "restore":
		if len(args) != 3 || args[2] == "" {
			return true, errors.New("invalid_backup: restore requires a backup directory")
		}
		// Only the canonical JSON format is accepted on the Mac command boundary.
		// Inspect every byte before checking availability or moving live state.
		if compose.BuildVersion == "dev" {
			if _, err := hostbackup.VerifySnapshotContext(ctx, filepath.Clean(args[2])); err != nil {
				return true, err
			}
			return true, errors.New("host_maintenance_unavailable: restore requires a versioned release binary and composed recovery providers")
		}

	default:
		return true, fmt.Errorf("invalid_command: unknown maintenance operation %q", args[1])
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return true, err
	}
	state := filepath.Join(home, "Library/Application Support/Smithers")
	head, err := product.HeadVersion()
	if err != nil {
		return true, err
	}
	version := hostbackup.Version{Release: compose.BuildVersion, Schema: head, PostgresMajor: 18}
	authority := &maintenanceAuthority{state: state, version: version}
	backup := hostbackup.BackupConfig{State: state, Version: version, Authority: authority, Cloner: hostbackup.APFSCloner{}}
	switch args[1] {
	case "backup":
		directory, err := hostbackup.Backup(ctx, backup)
		if err == nil {
			fmt.Fprintln(os.Stdout, directory)
		}
		return true, err
	case "upgrade":
		// Lifecycle, retained-disk isolation and new-binary continuation have not
		// qualified on the reference Mac. The coordinator refuses before a freeze.
		_, err := hostbackup.Upgrade(ctx, hostbackup.UpgradeConfig{BackupConfig: backup})
		return true, err
	case "restore":
		source := filepath.Clean(args[2])
		at, err := hostbackup.Restore(ctx, hostbackup.RestoreConfig{State: state, Backup: source, Version: version, Authority: installedRestoreAuthority(executable, state, source), Cloner: hostbackup.APFSCloner{}})
		if err == nil {
			fmt.Fprintln(os.Stdout, at.UTC().Format(time.RFC3339))
		}
		return true, err
	}
	return true, errors.New("invalid_command: maintenance operation required")
}

// installedRestoreAuthority composes restore from the installed bundle: its
// PostgreSQL programs load the dump, its microVM doctor proves isolation and
// its `smthrs host start` starts the result. A backend outside a bundle, or a
// bundle without those members, yields an authority that refuses before any
// tree moves; restore verifies the backup first either way.
func installedRestoreAuthority(executable func() (string, error), state, backup string) *restoreAuthority {
	unavailable := func(err error) *restoreAuthority {
		return &restoreAuthority{state: state, unavailable: fmt.Errorf("host_maintenance_unavailable: restore runs from an installed bundle: %w", err)}
	}
	if !filepath.IsAbs(backup) {
		return unavailable(errors.New("the backup directory must be absolute"))
	}
	host, err := openMaintenanceHost(executable, state)
	if err != nil {
		return unavailable(err)
	}
	database, err := host.postgres()
	if err != nil {
		return unavailable(err)
	}
	return &restoreAuthority{state: state, postgres: database, isolation: host.isolation, start: host.start(backup)}
}
