package repohostserver

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// staleGitLockAge is how old a git lock file must be before repo-host treats
// its writer as gone. Git and jj hold a ref lock for milliseconds, and every
// ref lock writer, maintenance included (maintenance.go), holds the repository
// lock, so the age only guards against a writer outside repo-host.
const staleGitLockAge = 2 * time.Minute

// repoGitDir is the git backend of the jj repository at repoPath.
func repoGitDir(repoPath string) string {
	return filepath.Join(repoPath, ".jj", "repo", "store", "git")
}

// lockRepo takes a live repository's write lock. Every write to a live
// repository's refs holds it (staging, move, delete and fork take the plain
// lock on paths that are not live yet, or no longer), so it is where the
// effects every ref write owes happen:
//   - on acquire, git lock files a crashed writer left are removed
//     (recoverStaleGitLocks), and the default bookmark is recorded born if it
//     exists;
//   - on release, jj's view is exported to git unless it already was at the
//     current operation head (warmGitRefs), and the default bookmark is
//     recorded born again; the repository is then queued for maintenance.
//
// A default bookmark that any write created, a push, a landing, an import or
// the bookmark API, is therefore born before its lock is released: a push can
// never recreate it (refuseDefaultBookmarkRewind).
//
// Like the lock it takes, it fails at once while the repository is held and
// when ctx ends first.
func (s *Server) lockRepo(ctx context.Context, repoPath string) (func(), error) {
	unlock, err := s.locks.Lock(ctx, repoPath)
	if err != nil {
		return nil, err
	}
	gitDir := repoGitDir(repoPath)
	s.recoverStaleGitLocks(gitDir)
	s.recordDefaultBookmarkBorn(gitDir)
	return func() {
		defer unlock()
		if _, err := os.Stat(gitDir); err == nil {
			s.warmGitRefs(repoPath)
			s.recordDefaultBookmarkBorn(gitDir)
			s.markMaintenanceDue(repoPath)
		}
	}, nil
}

// recordDefaultBookmarkBorn marks the default bookmark born when git holds it.
// It is the marker's only writer and runs under the repository lock.
func (s *Server) recordDefaultBookmarkBorn(gitDir string) {
	if _, err := os.Stat(gitDir); err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	bookmark, err := gitDefaultBookmark(ctx, gitDir)
	if err != nil || defaultBookmarkBorn(gitDir, bookmark) {
		return
	}
	if err := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "rev-parse", "--verify", "--quiet",
		"refs/heads/"+bookmark).Run(); err != nil {
		return
	}
	if err := markDefaultBookmarkBorn(gitDir, bookmark); err != nil && s.logger != nil {
		s.logger.Error("failed to record the default bookmark", "git_dir", gitDir, "error", err)
	}
}

// recoverStaleGitLocks removes the ref lock files (packed-refs.lock, HEAD.lock,
// refs/**/*.lock) older than staleGitLockAge. It runs under the repository
// lock, and repo-host is a live repository's only writer, so such a file was
// left by a writer that died holding it; git refuses every update of that ref
// (packed-refs.lock: of every ref) until it is gone. refs/jj/ is not walked:
// jj keeps one pin per commit there, each written once, so a leftover lock
// blocks nothing, and the walk stays proportional to the refs people use.
func (s *Server) recoverStaleGitLocks(gitDir string) {
	s.removeGitLocks(gitDir, staleGitLockAge)
}

// removeGitLocks removes the ref lock files recoverStaleGitLocks covers that
// are at least minAge old.
func (s *Server) removeGitLocks(gitDir string, minAge time.Duration) {
	candidates := []string{filepath.Join(gitDir, "packed-refs.lock"), filepath.Join(gitDir, "HEAD.lock")}
	jjRefs := filepath.Join(gitDir, filepath.FromSlash(strings.TrimSuffix(repohost.JJRefPrefix, "/")))
	_ = filepath.WalkDir(filepath.Join(gitDir, "refs"), func(path string, entry fs.DirEntry, err error) error {
		switch {
		case err != nil:
		case entry.IsDir() && path == jjRefs:
			return fs.SkipDir
		case !entry.IsDir() && strings.HasSuffix(entry.Name(), ".lock"):
			candidates = append(candidates, path)
		}
		return nil
	})
	for _, path := range candidates {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || time.Since(info.ModTime()) < minAge {
			continue
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			if s.logger != nil {
				s.logger.Error("failed to remove a stale git lock", "path", path, "error", err)
			}
			continue
		}
		s.metrics.staleGitLocks.Inc()
		if s.logger != nil {
			s.logger.Warn("removed a stale git lock", "path", path, "age", time.Since(info.ModTime()).String())
		}
	}
}
