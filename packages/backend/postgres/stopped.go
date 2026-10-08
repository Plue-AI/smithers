package postgres

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// ErrRunning reports a backend that owns the state directory, or a postmaster
// that still runs from it.
var ErrRunning = errors.New("owned postgres is running")

// Stopped returns nil when no backend owns stateDir and no postmaster runs
// from it. It is read-only: it creates no directory, lock or record, so an
// account that never held an install is stopped. Restore calls it before it
// moves any live tree. A live process it cannot identify refuses: it is never
// signalled and never assumed gone.
func Stopped(stateDir string) error {
	if !filepath.IsAbs(stateDir) {
		return errors.New("postgres state directory must be absolute")
	}
	info, err := os.Lstat(stateDir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("postgres state path must be a directory, not a symbolic link")
	}
	held, err := lockHeld(filepath.Join(stateDir, "owner.lock"))
	if err != nil {
		return err
	}
	if held {
		return ErrRunning
	}
	data := filepath.Join(stateDir, "data")
	pidFile, err := readPostmasterPID(filepath.Join(data, "postmaster.pid"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read existing postgres owner: %w", err)
	}
	alive, err := processAlive(pidFile.PID)
	if err != nil {
		return fmt.Errorf("inspect existing postgres process: %w", err)
	}
	if !alive {
		return nil
	}
	// The PID is live. It is this install's postmaster only when the owner
	// record's birth time and executable still describe it; a PID the system
	// reused for another program is not.
	recordBytes, err := os.ReadFile(filepath.Join(stateDir, "postmaster.owner.json"))
	if err != nil {
		return errors.New("live postgres has no verifiable Smithers owner record; stop it manually before restoring")
	}
	var record processRecord
	if json.Unmarshal(recordBytes, &record) != nil || record.PID != pidFile.PID {
		return errors.New("live postgres owner record does not match its data directory; stop it manually before restoring")
	}
	birth, executable, err := processIdentity(record.PID)
	if err != nil {
		return fmt.Errorf("inspect existing postgres process: %w", err)
	}
	if birth != record.Birth || executable != record.Executable {
		return nil
	}
	return ErrRunning
}
