package native

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/smithersai/smithers/packages/backend/internal/hostbackup"
	"github.com/smithersai/smithers/packages/backend/postgres"
)

// recoveryGrantPath is the grant file below the install state root. It lives
// in backups/, the one directory a backup never captures and a restore never
// moves, so it survives the tree swap that happens before the start it grants
// and can never arrive inside a restored tree.
const recoveryGrantPath = "backups/.recovery-start"

// recoveryGrant lets one owner operation start the install while its marker
// is durable. It names the backup the marker records and the operation's own
// process. The system reuses PIDs but not a PID with its start time, so the
// grant is void the moment that process is gone: a killed upgrade or restore
// leaves no start that the marker does not refuse.
type recoveryGrant struct {
	Backup string `json:"backup"`
	PID    int    `json:"pid"`
	Birth  string `json:"birth"`
}

// grantRecoveryStart grants this process's operation a start for backup.
// revoke removes the grant; a grant that outlives its process is void anyway.
func grantRecoveryStart(state, backup string) (revoke func() error, err error) {
	if !filepath.IsAbs(state) || !filepath.IsAbs(backup) || filepath.Clean(backup) != backup {
		return nil, errors.New("recovery start grant requires absolute state and backup directories")
	}
	birth, err := postgres.ProcessBirth(os.Getpid())
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(recoveryGrant{Backup: backup, PID: os.Getpid(), Birth: birth})
	if err != nil {
		return nil, err
	}
	path := filepath.Join(state, recoveryGrantPath)
	// backups/ exists: the marker's backup is inside it, or restore made it.
	info, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm() != 0700 {
		return nil, &hostbackup.Error{Code: hostbackup.UnsafePath, Path: "backups"}
	}
	// writeDurable creates the file 0600 and renames it into place.
	if err := writeDurable(path, string(body)+"\n"); err != nil {
		return nil, err
	}
	return func() error {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return syncDir(filepath.Dir(path))
	}, nil
}

// recoveryStartGranted reports whether a live owner operation granted a start
// for backup. Every doubt is a refusal: an unreadable or oversized file, a
// link, another backup, a process that has exited or whose PID now belongs to
// another program.
func recoveryStartGranted(state, backup string) bool {
	body, err := hostbackup.ReadMaintenanceMetadata(filepath.Join(state, recoveryGrantPath))
	if err != nil {
		return false
	}
	var grant recoveryGrant
	if json.Unmarshal(body, &grant) != nil || grant.Backup == "" || grant.Backup != backup || grant.PID <= 1 || grant.Birth == "" {
		return false
	}
	birth, err := postgres.ProcessBirth(grant.PID)
	return err == nil && birth == grant.Birth
}
