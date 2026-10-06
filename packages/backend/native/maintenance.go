package native

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/smithersai/smithers/packages/backend/db/product"
	"github.com/smithersai/smithers/packages/backend/internal/compose"
	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
)

// DispatchMaintenance is server-free: refusals cannot bootstrap PostgreSQL,
// migrate state, acquire a freeze or launch a repository runtime. The install
// currently has no coordinated capture/drain or authenticated CLI-owner bridge.
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
		if _, err := hostbackup.VerifySnapshot(filepath.Clean(args[2])); err != nil {
			return true, err
		}
		if compose.BuildVersion == "dev" {
			return true, errors.New("host_maintenance_unavailable: restore requires a versioned release binary and composed recovery providers")
		}
		head, err := product.HeadVersion()
		if err != nil {
			return true, err
		}
		if err := hostbackup.VerifyManifest(filepath.Clean(args[2]), hostbackup.Version{
			Release: compose.BuildVersion, Schema: head, PostgresMajor: 18,
		}); err != nil {
			return true, err
		}
	default:
		return true, fmt.Errorf("invalid_command: unknown maintenance operation %q", args[1])
	}
	return true, errors.New("host_maintenance_unavailable: owner authorization, admission/flow drain, verified machine capture, persistence flush and external-write recovery must be composed before host maintenance")
}
