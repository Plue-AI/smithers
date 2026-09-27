package repohostserver

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// A repo-host that crashed mid-maintenance can leave git running in the
// repository, in its own process group and outside any repository lock. The
// next repo-host deals with it before it serves a write (reapOrphanedMaintenance):
// a maintenance group its pidfile names, or a gc of the repository its gc.pid
// names, is terminated and the git locks it held are removed. A process that
// will not die, or a gc.pid whose process cannot be identified, holds writes
// to that repository only, until it is resolved. Like the repository locks,
// this assumes one repo-host owns the storage: a second one would terminate
// the first one's maintenance.

// gcPidMaxAge is the age past which git itself ignores a gc.pid.
const gcPidMaxAge = 12 * time.Hour

// gcStartSlack is how much later than its gc.pid a process may appear to have
// started and still be taken for its gc. Start times come from different
// clocks (/proc derives them from the current boot time) and round down; a
// larger wall-clock step goes undetected.
const gcStartSlack = 10 * time.Minute

// lookupProcessArgs reads a process's arguments.
var lookupProcessArgs = processArgs

// holdPollInterval is how often a held repository is checked again.
var holdPollInterval = 5 * time.Second

// reapOrphanedMaintenance settles every repository in storage before
// NewWithFFI returns, so before the server exists to accept a write. A
// repository settleMaintenance cannot clear is held (holdRepository); the
// others proceed.
func (s *Server) reapOrphanedMaintenance() {
	ctx, cancel := context.WithCancel(context.Background())
	s.stopHolds = cancel
	for _, gitDir := range s.repositoryGitDirs() {
		clear, reaped, reason := s.settleMaintenance(gitDir)
		switch {
		case !clear:
			s.holdRepository(ctx, gitDir, reason)
		case reaped:
			s.removeGitLocks(gitDir, 0)
		}
	}
}

// settleMaintenance terminates the orphaned maintenance of the repository at
// gitDir and removes a stale gc.pid. clear reports that no maintenance
// process outside repo-host's own remains, or may remain; reaped that one was
// terminated. reason says why the repository is not clear.
func (s *Server) settleMaintenance(gitDir string) (clear, reaped bool, reason string) {
	groupFound, groupAlive := s.reapMaintenanceGroup(gitDir)
	gcFound, gcReason := s.settleGCPid(gitDir)
	switch {
	case groupAlive:
		return false, true, "a maintenance process group survived SIGKILL"
	case gcReason != "":
		return false, gcFound, gcReason
	}
	return true, groupFound || gcFound, ""
}

// holdRepository holds writes to the repository at gitDir (repoLocker.Hold):
// every write fails at once with 503 and a Retry-After of holdPollInterval,
// over the JSON API and git alike, while reads proceed.
// The hold lasts until settleMaintenance clears the repository; the git locks
// the process may have held are then removed and the repository is queued
// for maintenance. Shutdown stops the checks but keeps the hold: nothing
// writes to the repository while its maintenance may still run. Background
// passes (maintenance, the user ref sweep) skip a held repository, and a read
// serves its git refs without exporting jj's view first (syncGitRefs).
func (s *Server) holdRepository(ctx context.Context, gitDir, reason string) {
	repoPath := repositoryPathOf(gitDir)
	release := s.locks.Hold(repoPath)
	if s.logger != nil {
		s.logger.Error("holding writes to a repository while maintenance outside repo-host may run", "git_dir", gitDir, "reason", reason)
	}
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		ticker := time.NewTicker(holdPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			if clear, _, _ := s.settleMaintenance(gitDir); clear {
				s.removeGitLocks(gitDir, 0)
				release()
				s.markMaintenanceDue(repoPath)
				if s.logger != nil {
					s.logger.Warn("released a held repository", "git_dir", gitDir)
				}
				return
			}
		}
	}()
}

// reapMaintenanceGroup terminates the process group gitDir's maintenance
// pidfile names while the file's lock is held: SIGTERM, then SIGKILL after
// maintenanceWaitDelay. found reports that a live group was found; alive that
// the lock is still held maintenanceWaitDelay after SIGKILL.
func (s *Server) reapMaintenanceGroup(gitDir string) (found, alive bool) {
	file, err := os.OpenFile(filepath.Join(gitDir, maintenancePidFile), os.O_RDWR, 0)
	if err != nil {
		return false, false
	}
	defer file.Close()
	fd := int(file.Fd())
	terminated, killed := false, false
	deadline := time.Now().Add(maintenanceWaitDelay)
	pgid := 0
	for syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		// The leader writes the group's id as it starts, so a crash just
		// after the fork leaves the file empty for an instant.
		raw, _ := os.ReadFile(file.Name())
		if id, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && id > 1 && id != syscall.Getpgrp() {
			pgid = id
		}
		switch {
		case pgid != 0 && !terminated:
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
			terminated = true
		case time.Now().After(deadline) && !killed:
			if pgid != 0 {
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			}
			killed = true
			deadline = time.Now().Add(maintenanceWaitDelay)
		case time.Now().After(deadline):
			return true, true
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !terminated && !killed {
		return false, false
	}
	if s.logger != nil {
		s.logger.Warn("terminated orphaned repository maintenance", "git_dir", gitDir, "pgid", pgid)
	}
	return true, false
}

// gcPidVerdict is what gitDir's gc.pid says about a running gc.
type gcPidVerdict int

const (
	// gcPidAbsent: there is no gc.pid.
	gcPidAbsent gcPidVerdict = iota
	// gcPidStale: the gc.pid names no running gc of this repository.
	gcPidStale
	// gcPidRunning: the gc.pid names a gc of this repository still running.
	gcPidRunning
	// gcPidUnknown: the gc.pid names a live git on this host that cannot be
	// identified.
	gcPidUnknown
)

// settleGCPid terminates the gc gitDir's gc.pid names while it runs on this
// repository, with its process group when it leads one (SIGTERM, then SIGKILL
// after maintenanceWaitDelay), and removes the gc.pid once it is stale. found
// reports that a running gc was found; reason, when not empty, why the
// repository is not clear: the gc survived, or its process cannot be
// identified. An unidentified process is never signalled and its gc.pid stays.
func (s *Server) settleGCPid(gitDir string) (found bool, reason string) {
	pid, verdict, why := inspectGCPid(gitDir)
	switch verdict {
	case gcPidAbsent:
		return false, ""
	case gcPidStale:
		_ = os.Remove(filepath.Join(gitDir, "gc.pid"))
		return false, ""
	case gcPidUnknown:
		return false, "gc.pid names pid " + strconv.Itoa(pid) + ": " + why
	}
	target := pid
	if pgid, err := syscall.Getpgid(pid); err == nil && pgid == pid && pgid != syscall.Getpgrp() {
		target = -pid
	}
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		_ = syscall.Kill(target, sig)
		deadline := time.Now().Add(maintenanceWaitDelay)
		for time.Now().Before(deadline) {
			switch _, verdict, _ := inspectGCPid(gitDir); verdict {
			case gcPidAbsent, gcPidStale:
				_ = os.Remove(filepath.Join(gitDir, "gc.pid"))
				if s.logger != nil {
					s.logger.Warn("terminated orphaned git gc", "git_dir", gitDir, "pid", pid)
				}
				return true, ""
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	return true, "git gc pid " + strconv.Itoa(pid) + " survived SIGKILL"
}

// inspectGCPid judges gitDir's gc.pid. It is stale only when that is
// established: the file is older than gcPidMaxAge, unreadable as git writes
// it, or names another host or a process that is gone, is not git, runs no gc
// on this repository, or started more than gcStartSlack after the file. It
// names a running gc when the process is git, runs gc on this repository and
// started before the file (within gcStartSlack). Any other case, a lookup that
// fails included, is unknown; why says what could not be established.
func inspectGCPid(gitDir string) (pid int, verdict gcPidVerdict, why string) {
	path := filepath.Join(gitDir, "gc.pid")
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, gcPidAbsent, ""
	} else if err != nil {
		return 0, gcPidUnknown, err.Error()
	}
	if time.Since(info.ModTime()) > gcPidMaxAge {
		return 0, gcPidStale, ""
	}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return 0, gcPidAbsent, ""
	} else if err != nil {
		return 0, gcPidUnknown, err.Error()
	}
	fields := strings.Fields(string(raw))
	host, err := os.Hostname()
	if err != nil {
		return 0, gcPidUnknown, err.Error()
	}
	if len(fields) != 2 || fields[1] != host {
		return 0, gcPidStale, ""
	}
	pid, err = strconv.Atoi(fields[0])
	if err != nil || pid <= 1 || pid == os.Getpid() {
		return pid, gcPidStale, ""
	}
	unknown := func(err error) (int, gcPidVerdict, string) {
		if errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) {
			return pid, gcPidStale, ""
		}
		return pid, gcPidUnknown, err.Error()
	}
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return pid, gcPidStale, ""
	} else if err != nil && !errors.Is(err, syscall.EPERM) {
		return unknown(err)
	}
	name, err := processName(pid)
	if err != nil {
		return unknown(err)
	}
	// Nix wraps git in a script that runs .git-wrapped.
	if name != "git" && name != ".git-wrapped" {
		return pid, gcPidStale, ""
	}
	args, err := lookupProcessArgs(pid)
	if err != nil {
		return unknown(err)
	}
	if !slices.Contains(args, "gc") {
		return pid, gcPidStale, ""
	}
	env, err := processEnv(pid)
	if err != nil {
		return unknown(err)
	}
	dir, err := gcGitDir(pid, args, env)
	if err != nil {
		return unknown(err)
	}
	if !sameDir(dir, gitDir) {
		return pid, gcPidStale, ""
	}
	start, err := processStart(pid)
	if err != nil {
		return unknown(err)
	}
	if start.After(info.ModTime().Add(gcStartSlack)) {
		return pid, gcPidStale, ""
	}
	if start.After(info.ModTime()) {
		return unknown(errors.New("started " + start.Sub(info.ModTime()).String() + " after gc.pid was written"))
	}
	return pid, gcPidRunning, ""
}

// gcGitDir is the git directory the git process pid, with arguments args and
// environment env, works on: its --git-dir argument, else its GIT_DIR, else
// its working directory. A relative one is resolved against the working
// directory.
func gcGitDir(pid int, args, env []string) (string, error) {
	dir := ""
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, "GIT_DIR="); ok {
			dir = value
		}
	}
	for i, arg := range args {
		if value, ok := strings.CutPrefix(arg, "--git-dir="); ok {
			dir = value
		} else if arg == "--git-dir" && i+1 < len(args) {
			dir = args[i+1]
		}
	}
	if filepath.IsAbs(dir) {
		return dir, nil
	}
	cwd, err := processCwd(pid)
	if err != nil {
		return "", err
	}
	return filepath.Join(cwd, dir), nil
}

// sameDir reports whether the paths a and b name one directory.
func sameDir(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	infoA, errA := os.Stat(a)
	infoB, errB := os.Stat(b)
	return errA == nil && errB == nil && os.SameFile(infoA, infoB)
}

// repositoryPathOf is the repository whose git directory is gitDir.
func repositoryPathOf(gitDir string) string {
	return filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(gitDir))))
}
