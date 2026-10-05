package repohostserver

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// repairRefCaseCollisions handles POST /repos/{id}/ref-case-collisions/repair
// (#2237). Refs that differ only in case predate the refusal of such refs; a
// variant of a reserved name (mythical, the default bookmark, a protected
// bookmark) blocks the canonical ref, so it is renamed to it or removed. A
// backup under refs/smithers/case-collision/ keeps every variant's commit
// (caseVariantRepair). Every other collision is reported. A second run finds
// nothing to repair.
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
	unlock, err := s.lockRepo(r.Context(), repoPath)
	if err != nil {
		return err
	}
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
	// A failed export would leave the plan to stale refs.
	if err := s.ffi.ExportGitRefs(repoPath); err != nil {
		return internalError("failed to export bookmarks", err)
	}
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
	defaultReadable := err == nil
	if err != nil {
		// Without a default, only mythical and protected names are reserved.
		defaultBookmark = ""
	}
	report := repohost.RefCaseCollisionReport{Collisions: repohost.PlanRefCaseCollisions(names, defaultBookmark, req.ProtectedPatterns)}
	if s.config.InstallMainMirror {
		refuseInstallMainRepair(report.Collisions, defaultBookmark, defaultReadable)
	}
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	changed := false
	repairErr := func() error {
		n := 0
		for i := range report.Collisions {
			collision := &report.Collisions[i]
			if collision.Action == repohost.RefCaseCollisionReported {
				continue
			}
			for _, variant := range collision.Variants {
				backup := repohost.RefCaseCollisionBackup(stamp, n, variant)
				n++
				repair := caseVariantRepair{Variant: variant, OID: refs[variant], Canonical: collision.Canonical, Backup: backup,
					Rename: collision.Action == repohost.RefCaseCollisionRenamed}
				touched, err := repair.run(r.Context(), gitDir)
				changed = changed || touched
				if err != nil {
					return internalError("failed to repair "+variant, err)
				}
				collision.Backups = append(collision.Backups, backup)
			}
		}
		return nil
	}()
	// Import before answering, including changes made before a later repair
	// failed. The lock release exports jj's view, so import must finish first.
	if changed {
		if err := s.ffi.ImportGitRefs(repoPath); err != nil {
			importErr := internalError("failed to import repaired refs", err)
			if repairErr == nil {
				return importErr
			}
			// Preserve the original refusal and both causes in the error receipt.
			if appErr, ok := repairErr.(*appError); ok {
				appErr.Cause = errors.Join(appErr.Cause, importErr)
			}
		}
	}
	if repairErr != nil {
		return repairErr
	}
	return writeJSON(w, http.StatusOK, report)
}

// caseVariantRepair backs up one case variant of a reserved ref, removes it
// and, for a rename, creates the missing canonical ref at its commit.
//
// On a case-insensitive filesystem (macOS, Windows) a loose ref's file also
// answers to every case variant of its name, so git cannot delete a variant
// by name: `git update-ref -d refs/heads/Mythical` reads and unlinks the
// loose refs/heads/mythical. The repair therefore never deletes a variant by
// name. A loose variant is removed only when a file carries exactly its name
// and is not the canonical ref's own file; a packed variant is removed by
// rewriting packed-refs under git's packed-refs.lock. After every step the
// canonical ref must still hold its prior value; otherwise it is restored and
// the repair stops.
type caseVariantRepair struct {
	Variant, OID, Canonical, Backup string
	Rename                          bool
}

// run reports whether it wrote a ref, so jj imports the result even when a
// later step failed.
func (c caseVariantRepair) run(ctx context.Context, gitDir string) (bool, error) {
	storage, err := hostexec.Git(ctx, "--git-dir", gitDir, "config", "--get", "extensions.refStorage").Output()
	if err == nil && strings.TrimSpace(string(storage)) != "files" {
		return false, fmt.Errorf("ref storage %q is not supported", strings.TrimSpace(string(storage)))
	}
	refs, err := listGitRefs(ctx, gitDir)
	if err != nil {
		return false, err
	}
	if refs[c.Variant] != c.OID {
		return false, fmt.Errorf("%s moved during the repair", c.Variant)
	}
	prior, hadCanonical := refs[c.Canonical]
	if c.Rename && hadCanonical {
		return false, fmt.Errorf("%s already exists", c.Canonical)
	}
	if err := updateRefs(ctx, gitDir, "create "+c.Backup+"\x00"+c.OID+"\x00"); err != nil {
		return false, err
	}
	// verify checks the canonical ref after a step and restores it when the
	// step moved or removed it.
	verify := func(step string) (map[string]string, error) {
		refs, err := listGitRefs(ctx, gitDir)
		if err != nil {
			return nil, err
		}
		if current, ok := refs[c.Canonical]; ok == hadCanonical && current == prior {
			return refs, nil
		}
		if !hadCanonical {
			return nil, fmt.Errorf("%s appeared during %s", c.Canonical, step)
		}
		restoreErr := updateRefs(ctx, gitDir, "update "+c.Canonical+"\x00"+prior+"\x00\x00")
		return nil, errors.Join(fmt.Errorf("%s changed during %s and was restored to %s; %s holds %s", c.Canonical, step, prior, c.Backup, c.OID), restoreErr)
	}
	if refs, err = verify("the backup"); err != nil {
		return true, err
	}
	if refs[c.Backup] != c.OID {
		return true, fmt.Errorf("backup %s was not written", c.Backup)
	}
	removedLoose, err := removeLooseCaseVariant(gitDir, c.Variant, c.Canonical, c.OID)
	if err != nil {
		return true, err
	}
	if _, err := verify("the loose variant's removal"); err != nil {
		return true, err
	}
	// A loose ref shadows a packed one of the same name, whose stale value
	// then goes with it.
	packedOID := c.OID
	if removedLoose {
		packedOID = ""
	}
	if err := removePackedRef(gitDir, c.Variant, packedOID); err != nil {
		return true, err
	}
	if refs, err = verify("the packed variant's removal"); err != nil {
		return true, err
	}
	if _, ok := refs[c.Variant]; ok {
		return true, fmt.Errorf("%s is still present", c.Variant)
	}
	if !c.Rename {
		return true, nil
	}
	// A failed rename puts the variant back, so the next run retries it
	// instead of leaving the name missing.
	if err := updateRefs(ctx, gitDir, "create "+c.Canonical+"\x00"+c.OID+"\x00"); err != nil {
		return true, errors.Join(err, updateRefs(ctx, gitDir, "create "+c.Variant+"\x00"+c.OID+"\x00"))
	}
	refs, err = listGitRefs(ctx, gitDir)
	if err != nil {
		return true, err
	}
	if refs[c.Canonical] != c.OID {
		return true, fmt.Errorf("%s was not created at %s", c.Canonical, c.OID)
	}
	return true, nil
}

// exactLooseRefPath returns the loose file whose path spells ref exactly,
// component by component, or "" when there is none. On a case-insensitive
// filesystem opening refs/heads/Mythical finds refs/heads/mythical; the
// directory listing does not.
func exactLooseRefPath(gitDir, ref string) (string, error) {
	path := gitDir
	parts := strings.Split(ref, "/")
	for i, part := range parts {
		entries, err := os.ReadDir(path)
		if errors.Is(err, fs.ErrNotExist) {
			return "", nil
		}
		if err != nil {
			return "", err
		}
		var entry fs.DirEntry
		for _, candidate := range entries {
			if candidate.Name() == part {
				entry = candidate
				break
			}
		}
		if entry == nil {
			return "", nil
		}
		path = filepath.Join(path, part)
		if last := i == len(parts)-1; last != entry.Type().IsRegular() || (!last && !entry.IsDir()) {
			return "", nil
		}
	}
	return path, nil
}

// removeLooseCaseVariant removes the loose file of variant when one carries
// exactly its name and it is a different file from canonical's own. Git's
// <ref>.lock is held while the file is checked and removed, and directories
// the removal empties go too: on a case-insensitive filesystem an empty
// refs/heads/Mythical/ would block the file refs/heads/mythical.
func removeLooseCaseVariant(gitDir, variant, canonical, oid string) (bool, error) {
	path, err := exactLooseRefPath(gitDir, variant)
	if err != nil || path == "" {
		return false, err
	}
	canonicalPath, err := exactLooseRefPath(gitDir, canonical)
	if err != nil {
		return false, err
	}
	if canonicalPath != "" {
		a, errA := os.Stat(path)
		b, errB := os.Stat(canonicalPath)
		if errA != nil || errB != nil || os.SameFile(a, b) {
			return false, errors.Join(fmt.Errorf("%s is %s's own file", variant, canonical), errA, errB)
		}
	}
	if err := removeLockedFile(path, func(raw []byte) error {
		// A symbolic variant is removed itself, never the ref it names.
		if content := strings.TrimSpace(string(raw)); content != oid && !strings.HasPrefix(content, "ref: ") {
			return fmt.Errorf("%s moved during the repair", variant)
		}
		return nil
	}); err != nil {
		return false, err
	}
	// Emptied directories go up to refs/, except refs/heads and refs/tags,
	// which git init makes: an empty refs/Notes/ would name the next
	// refs/notes/mythical refs/Notes/mythical on a case-insensitive
	// filesystem.
	refsDir := filepath.Join(gitDir, "refs")
	for dir := filepath.Dir(path); strings.HasPrefix(dir, refsDir+string(filepath.Separator)); dir = filepath.Dir(dir) {
		if dir == filepath.Join(refsDir, "heads") || dir == filepath.Join(refsDir, "tags") || os.Remove(dir) != nil {
			break // kept, or not empty
		}
	}
	return true, nil
}

// removeLockedFile removes path while holding git's <path>.lock, once check
// accepts its content.
func removeLockedFile(path string, check func([]byte) error) error {
	lock, err := os.OpenFile(path+".lock", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("lock %s: %w", filepath.Base(path), err)
	}
	defer func() {
		_ = lock.Close()
		_ = os.Remove(path + ".lock")
	}()
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := check(raw); err != nil {
		return err
	}
	return os.Remove(path)
}

// removePackedRef drops ref, and its peeled line, from packed-refs when it
// holds oid ("" for any value). It holds git's packed-refs.lock and replaces
// the file atomically, as git does.
func removePackedRef(gitDir, ref, oid string) error {
	packed := filepath.Join(gitDir, "packed-refs")
	lock, err := os.OpenFile(packed+".lock", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return fmt.Errorf("lock packed-refs: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = lock.Close()
			_ = os.Remove(packed + ".lock")
		}
	}()
	raw, err := os.ReadFile(packed)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var out strings.Builder
	found := false
	lines := strings.SplitAfter(string(raw), "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if value, name, ok := strings.Cut(strings.TrimRight(line, "\n"), " "); ok && !strings.HasPrefix(line, "#") && name == ref {
			if oid != "" && value != oid {
				return fmt.Errorf("packed %s moved during the repair", ref)
			}
			found = true
			for i+1 < len(lines) && strings.HasPrefix(lines[i+1], "^") {
				i++
			}
			continue
		}
		out.WriteString(line)
	}
	if !found {
		return nil
	}
	if _, err := lock.WriteString(out.String()); err != nil {
		return err
	}
	if err := lock.Sync(); err != nil {
		return err
	}
	if err := lock.Close(); err != nil {
		return err
	}
	if err := os.Rename(packed+".lock", packed); err != nil {
		return err
	}
	committed = true
	return nil
}

func updateRefs(ctx context.Context, gitDir, commands string) error {
	// --no-deref: a symbolic ref is written itself, never the branch it names.
	cmd := hostexec.Git(ctx, "--git-dir", gitDir, "update-ref", "--no-deref", "--stdin", "-z")
	cmd.Stdin = strings.NewReader(commands)
	if out, err := cmd.CombinedOutput(); err != nil {
		return errors.Join(err, errors.New(strings.TrimSpace(string(out))))
	}
	return nil
}
