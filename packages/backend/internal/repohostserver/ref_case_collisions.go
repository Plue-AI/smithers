package repohostserver

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// repairRefCaseCollisions handles POST /repos/{id}/ref-case-collisions/repair
// (#2237). Refs that differ only in case predate the refusal of such refs; a
// variant of a reserved name (mythical, the default bookmark, a protected
// bookmark) blocks the canonical ref, so it is renamed to it or removed. A
// backup under refs/smithers/case-collision/ keeps every variant's commit, and
// each variant's backup, removal and rename is one ref transaction. Every
// other collision is reported. A second run finds nothing to repair.
func (s *Server) repairRefCaseCollisions(w http.ResponseWriter, r *http.Request) error {
	done := s.metrics.StartOperation("RepairRefCaseCollisions")
	defer done()

	owner, repo, err := parseRepoID(chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	var req repohost.RefCaseCollisionRequest
	if err := decodeRequest(r, &req); err != nil {
		return err
	}
	repoPath := s.config.RepoPath(owner, repo)
	gitDir := s.config.GitBackendPath(owner, repo)
	unlock := s.locks.Lock(repoPath)
	defer unlock()
	if err := checkMutationDeadline(r.Context()); err != nil {
		return err
	}
	if _, err := os.Stat(gitDir); err != nil {
		if os.IsNotExist(err) {
			return notFound("repository not found")
		}
		return internalError("failed to inspect repository", err)
	}
	// jj bookmarks reach git only on export; count the unexported ones too.
	s.warmGitRefs(repoPath)
	refs, err := listGitRefs(r.Context(), gitDir)
	if err != nil {
		return internalError("failed to list refs", err)
	}
	names := make([]string, 0, len(refs))
	for name := range refs {
		key := repohost.RefKey(name)
		// The control plane's and jj's own namespaces are never bookmarks.
		if strings.HasPrefix(key, repohost.ReservedRefPrefix) || strings.HasPrefix(key, repohost.JJRefPrefix) {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	defaultBookmark, err := gitDefaultBookmark(r.Context(), gitDir)
	if err != nil {
		// Without a default, only mythical and protected names are reserved.
		defaultBookmark = ""
	}
	report := repohost.RefCaseCollisionReport{Collisions: repohost.PlanRefCaseCollisions(names, defaultBookmark, req.ProtectedPatterns)}
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	changed := false
	for i := range report.Collisions {
		collision := &report.Collisions[i]
		if collision.Action == repohost.RefCaseCollisionReported {
			continue
		}
		for _, variant := range collision.Variants {
			backup := repohost.RefCaseCollisionBackup(stamp, variant)
			rename := ""
			if collision.Action == repohost.RefCaseCollisionRenamed {
				rename = collision.Canonical
			}
			if err := moveCaseVariantRef(r.Context(), gitDir, variant, refs[variant], backup, rename); err != nil {
				return internalError("failed to repair "+variant, err)
			}
			collision.Backups = append(collision.Backups, backup)
			changed = true
		}
	}
	if changed {
		// jj drops the removed bookmarks and adopts a renamed one.
		if err := s.ffi.ImportGitRefs(repoPath); err != nil {
			return internalError("failed to import repaired refs", err)
		}
		s.warmGitRefs(repoPath)
	}
	return writeJSON(w, http.StatusOK, report)
}

// moveCaseVariantRef backs up variant at oid, deletes it and, when rename is
// set, creates rename at oid, in one ref transaction. On a case-insensitive
// filesystem the variant and its canonical name are one file, which one
// transaction cannot both lock: there the backup and removal commit first and
// the rename follows, and the backup still holds the commit if it fails.
func moveCaseVariantRef(ctx context.Context, gitDir, variant, oid, backup, rename string) error {
	var commands bytes.Buffer
	fmt.Fprintf(&commands, "create %s\x00%s\x00", backup, oid)
	fmt.Fprintf(&commands, "delete %s\x00%s\x00", variant, oid)
	if rename != "" {
		fmt.Fprintf(&commands, "create %s\x00%s\x00", rename, oid)
	}
	err := updateRefs(ctx, gitDir, commands.Bytes())
	if err == nil || rename == "" || !strings.EqualFold(variant, rename) {
		return err
	}
	commands.Reset()
	fmt.Fprintf(&commands, "create %s\x00%s\x00", backup, oid)
	fmt.Fprintf(&commands, "delete %s\x00%s\x00", variant, oid)
	if err := updateRefs(ctx, gitDir, commands.Bytes()); err != nil {
		return err
	}
	commands.Reset()
	fmt.Fprintf(&commands, "create %s\x00%s\x00", rename, oid)
	return updateRefs(ctx, gitDir, commands.Bytes())
}

func updateRefs(ctx context.Context, gitDir string, commands []byte) error {
	cmd := exec.CommandContext(ctx, "git", "--git-dir", gitDir, "update-ref", "--stdin", "-z")
	cmd.Stdin = bytes.NewReader(commands)
	if out, err := cmd.CombinedOutput(); err != nil {
		return errors.Join(err, errors.New(strings.TrimSpace(string(out))))
	}
	return nil
}
