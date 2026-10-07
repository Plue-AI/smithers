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
// Those providers must be composed before any destructive command is enabled.
func DispatchMaintenance(ctx context.Context, args []string) (bool, error) {
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
		at, err := hostbackup.Restore(ctx, hostbackup.RestoreConfig{State: state, Backup: filepath.Clean(args[2]), Version: version, Cloner: hostbackup.APFSCloner{}})
		if err == nil {
			fmt.Fprintln(os.Stdout, at.UTC().Format(time.RFC3339))
		}
		return true, err
	}
	return true, errors.New("invalid_command: maintenance operation required")
}
