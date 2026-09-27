package repohostserver

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// maxTrackedRefExports bounds the memory the export cache can hold. A host
// serves a bounded number of repositories, but a long-lived process that has
// seen churn (forks, moves, deletes) must not accumulate entries forever.
const maxTrackedRefExports = 8192

// refExportCache remembers, per repository path, the jj operation head that was
// current the last time jj bookmarks were exported to the git backend.
//
// Exporting refs means opening the jj repo, loading its view and index and
// running a jj transaction: work proportional to the repository's history. The
// git ref advertisement served to clients only needs the git backend, which
// cannot drift while the jj operation head is unchanged, so the export is
// skipped entirely on the read path of an unmodified repository.
type refExportCache struct {
	mu       sync.Mutex
	exported map[string]string
}

func newRefExportCache() *refExportCache {
	return &refExportCache{exported: map[string]string{}}
}

// current reports whether repoPath was exported at operation head opHead.
func (c *refExportCache) current(repoPath, opHead string) bool {
	if opHead == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.exported[repoPath] == opHead
}

// record marks repoPath as exported at operation head opHead.
func (c *refExportCache) record(repoPath, opHead string) {
	if opHead == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.exported) >= maxTrackedRefExports {
		// Cheapest bounded policy: drop everything and re-export lazily. A
		// dropped entry costs one extra export, never correctness.
		c.exported = map[string]string{}
	}
	c.exported[repoPath] = opHead
}

// forget drops any cached export state for repoPath. Used when a repository is
// removed or relocated so a path that is later reused cannot inherit stale
// state.
func (c *refExportCache) forget(repoPath string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.exported, repoPath)
}

// jjOperationHead returns a token identifying the repository's current jj
// operation head(s). Every jj mutation (push import, bookmark write, land,
// snapshot) commits a transaction and therefore moves the operation head, so an
// unchanged token means the jj view — and thus the set of refs an export would
// write — is unchanged.
//
// Reading the head is a single directory listing of
// `.jj/repo/op_heads/heads/`, whose entries are named after the operation IDs.
// An unreadable or empty directory returns an empty token, which callers treat
// as "unknown": they export unconditionally, preserving the previous behavior.
func jjOperationHead(repoPath string) string {
	entries, err := os.ReadDir(filepath.Join(repoPath, ".jj", "repo", "op_heads", "heads"))
	if err != nil {
		return ""
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		names = append(names, entry.Name())
	}
	if len(names) == 0 {
		return ""
	}
	sort.Strings(names)
	return strings.Join(names, ",")
}

// syncGitRefs makes the git backend's refs current with the jj view before a
// git read (ref advertisement or upload-pack negotiation).
//
// The common case — nothing has changed since the last export — takes no
// repository lock and does no jj work at all, so concurrent clones are served
// straight from the git backend instead of serializing behind a per-request jj
// export. Only when the jj operation head has moved does this take the
// repository write lock and run the export, and only one waiter does the work.
func (s *Server) syncGitRefs(repoPath, gitDir string) error {
	if _, err := os.Stat(gitDir); err != nil {
		return notFound("repository not found")
	}

	opHead := jjOperationHead(repoPath)
	if s.refExports.current(repoPath, opHead) {
		return nil
	}

	unlock := s.lockRepo(repoPath)
	defer unlock()

	// Re-check under the lock: a concurrent request may have exported while we
	// waited, in which case this request must not repeat the work.
	if s.refExports.current(repoPath, jjOperationHead(repoPath)) {
		return nil
	}

	if err := s.ffi.ExportGitRefs(repoPath); err != nil {
		return err
	}

	// Read the head again: a non-empty export commits a jj transaction and so
	// moves the head itself.
	s.refExports.record(repoPath, jjOperationHead(repoPath))
	return nil
}

// warmGitRefs exports refs and refreshes the cache from a caller that already
// holds the repository write lock, moving the export off the next reader's
// critical path. It is best effort: a failure is logged and leaves the cache
// untouched, so the next read still exports and still surfaces the error. An
// unreadable operation head is left to that read, which exports regardless.
func (s *Server) warmGitRefs(repoPath string) {
	opHead := jjOperationHead(repoPath)
	if opHead == "" || s.refExports.current(repoPath, opHead) {
		return
	}
	if err := s.ffi.ExportGitRefs(repoPath); err != nil {
		if s.logger != nil {
			s.logger.Warn("failed to refresh git refs after a jj mutation",
				"repo_path", repoPath, "error", err)
		}
		return
	}
	s.refExports.record(repoPath, jjOperationHead(repoPath))
}
