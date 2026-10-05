package repohostserver

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// A refused push is rolled back (restoreGitRefs). When the rollback cannot
// finish, or the refs the push left cannot be listed to roll it back, the
// repository holds refs no check authorized. Repo-host then holds every
// write to it: the hold file in its git directory records when and why, every
// write lock is refused while the file exists (repoLocker.Refusal), over the
// JSON API and git alike, and the hold outlives the process. Reads proceed.
// The operator restores the refs and removes the file; writes resume at once.

// rollbackHoldFile, in a repository's git directory, holds its writes.
const rollbackHoldFile = "smithers-rollback-hold"

// rollbackFailure is a refused push that was not rolled back, or whose refs
// could not be listed to roll it back.
type rollbackFailure struct{ err error }

func (f *rollbackFailure) Error() string { return "refused push not rolled back: " + f.err.Error() }

func (f *rollbackFailure) Unwrap() error { return f.err }

// rollbackHeld reports whether the repository at gitDir is held.
func rollbackHeld(gitDir string) bool {
	_, err := os.Lstat(filepath.Join(gitDir, rollbackHoldFile))
	return err == nil
}

// errRollbackHeld is the answer to a write to a held repository.
func errRollbackHeld() *appError {
	return &appError{
		StatusCode: http.StatusServiceUnavailable,
		Code:       repohost.RollbackHeldCode,
		Message:    "writes to this repository are held: a refused push could not be rolled back, and the operator must restore its refs",
	}
}

// holdFailedRollback holds the repository at gitDir when err is a
// rollbackFailure and answers the push with that; any other err is returned
// as it is. It runs before the push releases the repository lock, so no
// write reaches the repository between the failure and the hold.
func (s *Server) holdFailedRollback(gitDir string, err error) error {
	var failure *rollbackFailure
	if !errors.As(err, &failure) {
		return err
	}
	holdFile := filepath.Join(gitDir, rollbackHoldFile)
	record := fmt.Sprintf("%s %v\n", time.Now().UTC().Format(time.RFC3339), failure.err)
	writeErr := os.WriteFile(holdFile, []byte(record), 0o600)
	if writeErr == nil {
		writeErr = syncDirectory(gitDir)
	}
	if writeErr != nil {
		// Without the file the hold lasts until the process exits.
		s.locks.Hold(repositoryPathOf(gitDir))
	}
	if s.logger != nil {
		s.logger.Error("holding writes to a repository whose refused push could not be rolled back",
			"git_dir", gitDir, "hold_file", holdFile, "error", failure.err, "hold_file_error", writeErr)
	}
	return &appError{
		StatusCode: http.StatusInternalServerError,
		Code:       repohost.RollbackHeldCode,
		Message:    "the push was refused and could not be rolled back; writes to this repository are held until the operator restores its refs",
		Cause:      failure.err,
	}
}
