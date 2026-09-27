package repohostserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Repository maintenance runs under the repository lock, from repo-host only.
//
// Git's automatic maintenance (receive-pack's receive.autogc, the gc --auto
// that fetch and commit start, maintenance --auto) packs refs and writes ref
// locks after the command that started it returned, outside the repository
// lock, where recoverStaleGitLocks could take its lock files for a crashed
// writer's. Every repository repo-host manages therefore has it disabled in its
// own git config, so the setting holds for every git and jj process whatever
// its environment; creation sets it and the startup sweep backfills it.
// repo-host then packs refs and runs gc itself, excluding writers: every
// repository written since the last pass, and at startup every repository.

// maintenanceInterval is how often repositories written since the last pass
// are maintained.
const maintenanceInterval = 10 * time.Minute

// maintenanceTimeout bounds one repository's maintenance.
const maintenanceTimeout = 30 * time.Minute

// autoMaintenanceOff is the git config that turns automatic maintenance off.
// receive.autogc is written last: once it reads false, the set is complete.
var autoMaintenanceOff = [][2]string{
	{"gc.auto", "0"},
	{"maintenance.auto", "false"},
	{"receive.autogc", "false"},
}

// disableAutoMaintenance writes autoMaintenanceOff to the repository at gitDir.
// A missing git directory has nothing to configure.
func disableAutoMaintenance(ctx context.Context, gitDir string) error {
	if _, err := os.Stat(gitDir); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if out, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "config", "--get", "receive.autogc").Output(); err == nil && strings.TrimSpace(string(out)) == "false" {
		return nil
	}
	for _, setting := range autoMaintenanceOff {
		if out, err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "config", setting[0], setting[1]).CombinedOutput(); err != nil {
			return errors.New("git config " + setting[0] + ": " + strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// maintenanceCommandContext builds maintenance git processes.
var maintenanceCommandContext = exec.CommandContext

// packRefsArgs packs loose refs when git's heuristic calls for it.
var packRefsArgs = []string{"pack-refs", "--auto", "--all"}

// gcArgs runs gc, in the foreground, when git's default thresholds (which the
// repository config turned off) call for it.
var gcArgs = []string{"-c", "gc.auto=6700", "-c", "gc.autoDetach=false", "-c", "maintenance.autoDetach=false", "gc", "--auto", "--quiet"}

// maintenanceWaitDelay is how long a cancelled maintenance process has to exit
// on SIGTERM before it is killed.
var maintenanceWaitDelay = 10 * time.Second

// maintenancePidFile, in a repository's git directory, records the process
// group of the maintenance git running there. That git and every process it
// starts inherit an open descriptor holding the file's flock, so the lock is
// held exactly while one of them lives, whatever pids the system reuses: a
// repo-host that crashed mid-maintenance leaves a held lock and the group to
// terminate (reapOrphanedMaintenance). The group's leader writes the file
// itself, through that descriptor, before it becomes git.
const maintenancePidFile = "smithers-maintenance.pid"

// maintenanceExec is the shell program the maintenance process starts as: it
// records its pid, its group's id, through the pidfile descriptor (fd 3) and
// then becomes git with the given arguments.
const maintenanceExec = `echo $$ >&3 && exec "$0" "$@"`

// runMaintenanceGit runs one maintenance git command in its own process group.
// On cancellation the whole group gets SIGTERM, so git and the children it
// started (repack, pack-objects, pack-refs) remove their lock files and exit;
// whatever is left is killed before this returns, so no maintenance process
// outlives the repository lock its caller holds. If repo-host itself dies, git
// gets SIGTERM where the platform supports it (setMaintenanceParentDeathSignal)
// and the next repo-host terminates the rest before serving writes.
func runMaintenanceGit(ctx context.Context, gitDir string, args []string) error {
	pidFile, err := os.OpenFile(filepath.Join(gitDir, maintenancePidFile), os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	defer pidFile.Close()
	if err := syscall.Flock(int(pidFile.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("maintenance is already running in " + gitDir)
	}
	if err := pidFile.Truncate(0); err != nil {
		return err
	}
	cmd := maintenanceCommandContext(ctx, "sh", append([]string{"-c", maintenanceExec, "git", "--git-dir", gitDir}, args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	setMaintenanceParentDeathSignal(cmd.SysProcAttr)
	cmd.ExtraFiles = []*os.File{pidFile}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = maintenanceWaitDelay
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		return errors.New("git " + strings.Join(args, " ") + ": " + err.Error())
	}
	_ = pidFile.Close()
	err = cmd.Wait()
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if err != nil {
		return errors.New("git " + strings.Join(args, " ") + ": " + err.Error() + ": " + strings.TrimSpace(out.String()))
	}
	return nil
}

// gcPidMaxAge is the age past which git itself ignores a gc.pid.
const gcPidMaxAge = 12 * time.Hour

// reapOrphanedMaintenance terminates maintenance processes a crashed
// repo-host left running, then removes the git locks they held, whatever
// their age. NewWithFFI runs it before the server exists to serve anything, so
// no write meets a gc that holds no repository lock; one that will not die
// fails startup rather than lose its locks. A repository's orphans are the
// group its maintenance pidfile names, while that file's lock is held, and a
// gc its gc.pid names that is alive on this host, as git itself judges it (a
// gc from a repo-host that predates maintenance pidfiles, or git's own
// detached gc from before automatic maintenance was turned off). Like the
// repository locks, this assumes one repo-host owns the storage: a second one
// would terminate the first one's maintenance.
func (s *Server) reapOrphanedMaintenance() error {
	for _, gitDir := range s.repositoryGitDirs() {
		group, err := s.reapMaintenanceGroup(gitDir)
		if err != nil {
			return err
		}
		gc, err := s.reapGitGC(gitDir)
		if err != nil {
			return err
		}
		if !group && !gc {
			continue
		}
		if _, alive := liveGitGC(gitDir); !alive {
			_ = os.Remove(filepath.Join(gitDir, "gc.pid"))
		}
		s.removeGitLocks(gitDir, 0)
	}
	return nil
}

// reapMaintenanceGroup terminates the process group gitDir's maintenance
// pidfile names while the file's lock is held: SIGTERM, then SIGKILL after
// maintenanceWaitDelay. It reports whether a live group was found, and fails
// if the lock is still held maintenanceWaitDelay after SIGKILL.
func (s *Server) reapMaintenanceGroup(gitDir string) (bool, error) {
	file, err := os.OpenFile(filepath.Join(gitDir, maintenancePidFile), os.O_RDWR, 0)
	if err != nil {
		return false, nil
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
			return true, fmt.Errorf("orphaned repository maintenance (process group %d) in %s is still running", pgid, gitDir)
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !terminated && !killed {
		return false, nil
	}
	if s.logger != nil {
		s.logger.Warn("terminated orphaned repository maintenance", "git_dir", gitDir, "pgid", pgid)
	}
	return true, nil
}

// liveGitGC reports the pid in gitDir's gc.pid when git would judge that gc
// running: the file is younger than gcPidMaxAge, names this host and a live
// process, and that process is git (not a process that reused the pid).
func liveGitGC(gitDir string) (int, bool) {
	path := filepath.Join(gitDir, "gc.pid")
	info, err := os.Stat(path)
	if err != nil || time.Since(info.ModTime()) > gcPidMaxAge {
		return 0, false
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	fields := strings.Fields(string(raw))
	host, _ := os.Hostname()
	if len(fields) != 2 || fields[1] != host {
		return 0, false
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil || pid <= 1 || pid == os.Getpid() || syscall.Kill(pid, 0) != nil {
		return 0, false
	}
	name, err := processName(pid)
	if err != nil || filepath.Base(name) != "git" {
		return 0, false
	}
	return pid, true
}

// reapGitGC terminates the live gc gitDir's gc.pid names (liveGitGC), with
// its process group when it leads one: SIGTERM, then SIGKILL after
// maintenanceWaitDelay. It reports whether one was found, and fails if it is
// still alive maintenanceWaitDelay after SIGKILL.
func (s *Server) reapGitGC(gitDir string) (bool, error) {
	pid, alive := liveGitGC(gitDir)
	if !alive {
		return false, nil
	}
	target := pid
	if pgid, err := syscall.Getpgid(pid); err == nil && pgid == pid && pgid != syscall.Getpgrp() {
		target = -pid
	}
	for _, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		_ = syscall.Kill(target, sig)
		deadline := time.Now().Add(maintenanceWaitDelay)
		for time.Now().Before(deadline) {
			if _, alive := liveGitGC(gitDir); !alive {
				if s.logger != nil {
					s.logger.Warn("terminated orphaned git gc", "git_dir", gitDir, "pid", pid)
				}
				return true, nil
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	return true, fmt.Errorf("orphaned git gc (pid %d) in %s is still running", pid, gitDir)
}

// markMaintenanceDue queues repoPath for the next maintenance pass.
func (s *Server) markMaintenanceDue(repoPath string) {
	s.maintenanceMu.Lock()
	defer s.maintenanceMu.Unlock()
	if s.maintenanceDue == nil {
		s.maintenanceDue = map[string]struct{}{}
	}
	s.maintenanceDue[repoPath] = struct{}{}
}

func (s *Server) takeMaintenanceDue() []string {
	s.maintenanceMu.Lock()
	defer s.maintenanceMu.Unlock()
	due := make([]string, 0, len(s.maintenanceDue))
	for repoPath := range s.maintenanceDue {
		due = append(due, repoPath)
	}
	s.maintenanceDue = nil
	return due
}

// maintainRepository maintains the repository at repoPath. Under the write
// lock it runs locked (if any), removes stale git locks, turns automatic
// maintenance off and packs refs; gc then runs under the read lock, which
// excludes every writer (and so stale lock recovery) but lets clones and
// fetches continue. It takes the plain lock, not lockRepo: maintenance changes
// no ref's value, so it owes no export and must not queue the repository again.
func (s *Server) maintainRepository(ctx context.Context, repoPath string, locked func(gitDir string)) {
	gitDir := repoGitDir(repoPath)
	ctx, cancel := context.WithTimeout(ctx, maintenanceTimeout)
	defer cancel()
	unlock := s.locks.Lock(repoPath)
	if _, err := os.Stat(gitDir); err != nil {
		unlock()
		return
	}
	if locked != nil {
		locked(gitDir)
	}
	s.recoverStaleGitLocks(gitDir)
	err := disableAutoMaintenance(ctx, gitDir)
	if err == nil {
		err = runMaintenanceGit(ctx, gitDir, packRefsArgs)
	}
	unlock()
	if err == nil {
		unlockRead := s.locks.RLock(repoPath)
		if _, statErr := os.Stat(gitDir); statErr == nil {
			err = runMaintenanceGit(ctx, gitDir, gcArgs)
		}
		unlockRead()
	}
	if err != nil && ctx.Err() == nil && s.logger != nil {
		s.logger.Error("repository maintenance failed", "git_dir", gitDir, "error", err)
	}
}

// startMaintenance runs sweepAllRepositories once, then maintains the
// repositories written since the last pass every interval, until Shutdown.
func (s *Server) startMaintenance(interval time.Duration) {
	ctx, cancel := context.WithCancel(context.Background())
	s.stopMaintenance = cancel
	s.background.Add(1)
	go func() {
		defer s.background.Done()
		s.sweepAllRepositories(ctx)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			for _, repoPath := range s.takeMaintenanceDue() {
				if ctx.Err() != nil {
					return
				}
				s.maintainRepository(ctx, repoPath, nil)
			}
		}
	}()
}

// sweepAllRepositories visits every repository in storage under its lock: it
// records the default bookmark of repositories that predate the born marker,
// backfills autoMaintenanceOff and maintains the repository. It exports
// nothing: the first read of each repository still does.
func (s *Server) sweepAllRepositories(ctx context.Context) {
	for _, gitDir := range s.repositoryGitDirs() {
		if ctx.Err() != nil {
			return
		}
		repoPath := filepath.Dir(filepath.Dir(filepath.Dir(filepath.Dir(gitDir))))
		var locked func(string)
		if !strings.HasSuffix(repoPath, wikiRepoSuffix) && !strings.HasSuffix(repoPath, docsRepoSuffix) {
			locked = s.recordDefaultBookmarkBorn
		}
		s.maintainRepository(ctx, repoPath, locked)
	}
}

// repositoryGitDirs lists the git directory of every repository in storage.
func (s *Server) repositoryGitDirs() []string {
	gitDirs, _ := filepath.Glob(filepath.Join(s.config.StoragePath, "*", "*", ".jj", "repo", "store", "git"))
	return gitDirs
}
