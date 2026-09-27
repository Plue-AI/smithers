package repohostserver

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
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

// runMaintenanceGit runs one maintenance git command in its own process group.
// On cancellation the whole group gets SIGTERM, so git and the children it
// started (repack, pack-objects, pack-refs) remove their lock files and exit;
// whatever is left is killed before this returns, so no maintenance process
// outlives the repository lock its caller holds.
func runMaintenanceGit(ctx context.Context, gitDir string, args []string) error {
	cmd := maintenanceCommandContext(ctx, "git", append([]string{"--git-dir", gitDir}, args...)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	cmd.WaitDelay = maintenanceWaitDelay
	out, err := cmd.CombinedOutput()
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	if err != nil {
		return errors.New("git " + strings.Join(args, " ") + ": " + err.Error() + ": " + strings.TrimSpace(string(out)))
	}
	return nil
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
	gitDirs, err := filepath.Glob(filepath.Join(s.config.StoragePath, "*", "*", ".jj", "repo", "store", "git"))
	if err != nil {
		return
	}
	for _, gitDir := range gitDirs {
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
