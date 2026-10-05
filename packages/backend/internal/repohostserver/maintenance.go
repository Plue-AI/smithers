package repohostserver

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/smithersai/smithers/packages/backend/hostexec"
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
	if out, err := hostexec.Git(ctx, "--git-dir", gitDir, "config", "--get", "receive.autogc").Output(); err == nil && strings.TrimSpace(string(out)) == "false" {
		return nil
	}
	for _, setting := range autoMaintenanceOff {
		if out, err := hostexec.Git(ctx, "--git-dir", gitDir, "config", setting[0], setting[1]).CombinedOutput(); err != nil {
			return errors.New("git config " + setting[0] + ": " + strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// maintenanceCommandContext builds maintenance git processes.
var maintenanceCommandContext = exec.CommandContext

// packRefsArgs packs every loose ref. It names only options the repo-host
// image's git (Debian bookworm's 2.39) knows: that git refuses
// `pack-refs --auto`, and a failed pack-refs skips gc, so no repository was
// ever repacked (smithersai/smithers#3070).
var packRefsArgs = []string{"pack-refs", "--all"}

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

// maintenanceExec is the shell program the maintenance process starts as
// (the system shell, by its absolute path): it records its pid, its group's
// id, through the pidfile descriptor (fd 3) and then becomes git, by git's
// absolute path, with the given arguments.
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
	program, argv, err := hostexec.GitArgv(append([]string{"--git-dir", gitDir}, args...)...)
	if err != nil {
		return err
	}
	cmd := maintenanceCommandContext(ctx, hostexec.Shell, append([]string{"-c", maintenanceExec, program}, argv...)...)
	cmd.Env = hostexec.GitEnvironment()
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
	// A gc killed here leaves its gc.pid, whose pid may be reused.
	gcPid := filepath.Join(gitDir, "gc.pid")
	if raw, readErr := os.ReadFile(gcPid); readErr == nil {
		if fields := strings.Fields(string(raw)); len(fields) > 0 && fields[0] == strconv.Itoa(cmd.Process.Pid) {
			_ = os.Remove(gcPid)
		}
	}
	if err != nil {
		return errors.New("git " + strings.Join(args, " ") + ": " + err.Error() + ": " + strings.TrimSpace(out.String()))
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
	if s.locks.Held(repoPath) {
		return
	}
	parent := ctx
	ctx, cancel := context.WithTimeout(ctx, maintenanceTimeout)
	defer cancel()
	unlock, err := s.locks.Lock(ctx, repoPath)
	if err != nil {
		// Timed out waiting behind writers: try again next pass.
		if parent.Err() == nil {
			s.markMaintenanceDue(repoPath)
		}
		return
	}
	if _, err := os.Stat(gitDir); err != nil {
		unlock()
		return
	}
	if locked != nil {
		locked(gitDir)
	}
	s.recoverStaleGitLocks(gitDir)
	err = disableAutoMaintenance(ctx, gitDir)
	if err == nil {
		err = runMaintenanceGit(ctx, gitDir, packRefsArgs)
	}
	unlock()
	if err == nil {
		var unlockRead func()
		if unlockRead, err = s.locks.RLock(ctx, repoPath); err == nil {
			if _, statErr := os.Stat(gitDir); statErr == nil {
				err = runMaintenanceGit(ctx, gitDir, gcArgs)
			}
			unlockRead()
		}
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
		repoPath := repositoryPathOf(gitDir)
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
