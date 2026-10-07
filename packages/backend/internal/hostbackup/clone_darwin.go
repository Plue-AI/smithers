//go:build darwin

package hostbackup

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// APFSCloner uses the kernel's clone operation, never a copying fallback.
// clonefile clones directory trees recursively, preserving modes and holes.
// Inputs must already have been verified as confined snapshot trees.
type APFSCloner struct{}

func (APFSCloner) Clone(source, destination string) error {
	sourceDir, err := os.Open(filepath.Dir(source))
	if err != nil {
		return err
	}
	defer sourceDir.Close()
	destinationDir, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer destinationDir.Close()
	return (APFSCloner{}).CloneAt(sourceDir, filepath.Base(source), destinationDir, filepath.Base(destination))
}

func (APFSCloner) CloneAt(sourceDir *os.File, source string, destinationDir *os.File, destination string) error {
	if !safePath(source) || filepath.Base(source) != source || !safePath(destination) || filepath.Base(destination) != destination {
		return &Error{Code: UnsafePath, Path: source}
	}
	// Hold both ancestors through the syscall, including the filesystem check.
	// A renamed/replaced ancestor cannot redirect the clone to an outside tree.
	for _, directory := range []*os.File{sourceDir, destinationDir} {
		if err := checkAPFSDirectory(directory); err != nil {
			return err
		}
	}
	var info unix.Stat_t
	if err := unix.Fstatat(int(destinationDir.Fd()), filepath.Base(destination), &info, unix.AT_SYMLINK_NOFOLLOW); err != unix.ENOENT {
		if err != nil {
			return err
		}
		return &Error{Code: ExtraFile, Path: destination}
	}
	if err := unix.Clonefileat(int(sourceDir.Fd()), filepath.Base(source), int(destinationDir.Fd()), filepath.Base(destination), unix.CLONE_NOFOLLOW); err != nil {
		return errors.Join(&Error{Code: CloneUnavailable, Path: source}, err)
	}
	return nil
}

// CheckAPFSVolume pins the state directory for the read-only preflight. CloneAt
// checks its pinned descriptors again when copying; no fallback can copy bytes.
func CheckAPFSVolume(path string) error {
	root, err := openSnapshot(path)
	if err != nil {
		return err
	}
	defer root.Close()
	directory, err := root.Open(".")
	if err != nil {
		return err
	}
	defer directory.Close()
	return checkAPFSDirectory(directory)
}
func checkAPFSDirectory(directory *os.File) error {
	var stat unix.Statfs_t
	if err := unix.Fstatfs(int(directory.Fd()), &stat); err != nil {
		return err
	}
	if string(bytes.TrimRight(stat.Fstypename[:], "\x00")) != "apfs" {
		return &Error{Code: CloneUnavailable, Path: directory.Name()}
	}
	return nil
}
