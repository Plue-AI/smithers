package repohostserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// caseRepairDirs are the filesystems the case-variant repair is tested on:
// the default temp directory, plus every directory SMITHERS_REF_CASE_DIRS
// lists (colon-separated), such as case-insensitive and case-sensitive APFS
// disk images mounted with hdiutil.
func caseRepairDirs(t *testing.T) []string {
	dirs := []string{t.TempDir()}
	for _, dir := range strings.Split(os.Getenv("SMITHERS_REF_CASE_DIRS"), ":") {
		if dir = strings.TrimSpace(dir); dir != "" {
			sub, err := os.MkdirTemp(dir, "case-repair-")
			require.NoError(t, err)
			t.Cleanup(func() { _ = os.RemoveAll(sub) })
			dirs = append(dirs, sub)
		}
	}
	return dirs
}

func caseInsensitive(t *testing.T, dir string) bool {
	probe := filepath.Join(dir, "CaseProbe")
	require.NoError(t, os.WriteFile(probe, nil, 0o644))
	defer os.Remove(probe)
	_, err := os.Stat(filepath.Join(dir, "caseprobe"))
	return err == nil
}

type caseRepo struct {
	t      *testing.T
	gitDir string
	a, b   string
}

func newCaseRepo(t *testing.T, dir string) *caseRepo {
	gitDir := filepath.Join(dir, "repo.git")
	r := &caseRepo{t: t, gitDir: gitDir}
	r.git("", "init", "--bare", "--quiet", "--initial-branch=main", gitDir)
	tree := r.git("", "--git-dir", gitDir, "mktree")
	r.a = r.git("", "--git-dir", gitDir, "commit-tree", tree, "-m", "a")
	r.b = r.git("", "--git-dir", gitDir, "commit-tree", tree, "-p", r.a, "-m", "b")
	return r
}

func (r *caseRepo) git(stdin string, args ...string) string {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Stdin = strings.NewReader(stdin)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
	out, err := cmd.CombinedOutput()
	require.NoError(r.t, err, "git %v: %s", args, out)
	return strings.TrimSpace(string(out))
}

// write stores refs the way git does: loose refs as files named exactly by
// the ref, packed refs as sorted packed-refs lines.
func (r *caseRepo) write(loose, packed map[string]string) {
	r.t.Helper()
	for ref, oid := range loose {
		path := filepath.Join(r.gitDir, filepath.FromSlash(ref))
		require.NoError(r.t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(r.t, os.WriteFile(path, []byte(oid+"\n"), 0o644))
	}
	names := make([]string, 0, len(packed))
	for ref := range packed {
		names = append(names, ref)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString("# pack-refs with: peeled fully-peeled sorted \n")
	for _, ref := range names {
		fmt.Fprintf(&b, "%s %s\n", packed[ref], ref)
	}
	require.NoError(r.t, os.WriteFile(filepath.Join(r.gitDir, "packed-refs"), []byte(b.String()), 0o644))
}

func (r *caseRepo) refs() map[string]string {
	r.t.Helper()
	refs, err := listGitRefs(context.Background(), r.gitDir)
	require.NoError(r.t, err)
	return refs
}

// TestCaseVariantRepairKeepsCanonicalRef covers every storage of a reserved
// ref and its case variant. On a case-insensitive filesystem a loose ref's
// file answers to every spelling of its name, so deleting the variant by name
// deleted the canonical ref (#2237).
func TestCaseVariantRepairKeepsCanonicalRef(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	const canonical, variant = "refs/heads/mythical", "refs/heads/Mythical"
	for _, dir := range caseRepairDirs(t) {
		insensitive := caseInsensitive(t, dir)
		for _, canonicalStorage := range []string{"loose", "packed", "absent"} {
			for _, variantStorage := range []string{"loose", "packed", "loose+stale packed"} {
				for _, sameCommit := range []bool{true, false} {
					for _, rename := range []bool{false, true} {
						if rename != (canonicalStorage == "absent") && rename {
							continue
						}
						if insensitive && canonicalStorage == "loose" && strings.HasPrefix(variantStorage, "loose") {
							continue // one file on this filesystem
						}
						name := fmt.Sprintf("insensitive=%t/canonical=%s/variant=%s/same=%t/rename=%t", insensitive, canonicalStorage, variantStorage, sameCommit, rename)
						t.Run(name, func(t *testing.T) {
							sub, err := os.MkdirTemp(dir, "case")
							require.NoError(t, err)
							defer os.RemoveAll(sub)
							r := newCaseRepo(t, sub)
							prior, oid := r.a, r.a
							if !sameCommit {
								oid = r.b
							}
							loose, packed := map[string]string{}, map[string]string{}
							switch canonicalStorage {
							case "loose":
								loose[canonical] = prior
							case "packed":
								packed[canonical] = prior
							}
							switch variantStorage {
							case "loose":
								loose[variant] = oid
							case "packed":
								packed[variant] = oid
							default:
								loose[variant] = oid
								packed[variant] = r.b
								if oid == r.b {
									packed[variant] = r.a
								}
							}
							r.write(loose, packed)
							before := r.refs()
							require.Equal(t, oid, before[variant])
							if canonicalStorage != "absent" {
								require.Equal(t, prior, before[canonical])
							}

							backup := repohost.RefCaseCollisionBackup("t", 0, variant)
							touched, err := caseVariantRepair{Variant: variant, OID: oid, Canonical: canonical, Backup: backup, Rename: rename}.run(context.Background(), r.gitDir)
							require.NoError(t, err)
							require.True(t, touched)

							after := r.refs()
							_, stillThere := after[variant]
							require.False(t, stillThere, "the variant is removed")
							require.Equal(t, oid, after[backup], "the backup keeps the variant's commit")
							want := ""
							switch {
							case canonicalStorage != "absent":
								want = prior
							case rename:
								want = oid
							}
							got, present := after[canonical]
							require.Equal(t, want != "", present, "canonical presence")
							require.Equal(t, want, got)
							if want != "" {
								// git's own read of the name agrees: no loose file shadows it.
								require.Equal(t, want, r.git("", "--git-dir", r.gitDir, "rev-parse", "--verify", canonical))
							}
							require.Len(t, after, len(before)-1+1+map[bool]int{true: 1}[rename], "no other ref changed: %v", after)
						})
					}
				}
			}
		}
	}
}

// A ref inside a variant of a missing reserved name goes with the directory
// the removal empties, which would otherwise block the reserved ref's file.
func TestCaseVariantRepairRemovesDirectoryVariant(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	for _, dir := range caseRepairDirs(t) {
		r := newCaseRepo(t, dir)
		r.write(map[string]string{"refs/heads/Mythical/x": r.a}, nil)
		_, err := caseVariantRepair{Variant: "refs/heads/Mythical/x", OID: r.a, Canonical: "refs/heads/mythical",
			Backup: repohost.RefCaseCollisionBackup("t", 0, "refs/heads/Mythical/x")}.run(context.Background(), r.gitDir)
		require.NoError(t, err)
		_, err = os.Stat(filepath.Join(r.gitDir, "refs", "heads", "Mythical"))
		require.True(t, errors.Is(err, os.ErrNotExist), "the emptied directory is removed: %v", err)
		r.git("", "--git-dir", r.gitDir, "update-ref", "refs/heads/mythical", r.b)
		require.Equal(t, r.b, r.refs()["refs/heads/mythical"])

		// A category directory in another case goes too, or the next
		// refs/notes/mythical would be listed as refs/Notes/mythical.
		r.write(map[string]string{"refs/Notes/mythical": r.a}, nil)
		_, err = caseVariantRepair{Variant: "refs/Notes/mythical", OID: r.a, Canonical: "refs/notes/mythical",
			Backup: repohost.RefCaseCollisionBackup("t", 1, "refs/Notes/mythical")}.run(context.Background(), r.gitDir)
		require.NoError(t, err)
		r.git("", "--git-dir", r.gitDir, "update-ref", "refs/notes/mythical", r.b)
		refs := r.refs()
		require.Equal(t, r.b, refs["refs/notes/mythical"])
		_, variant := refs["refs/Notes/mythical"]
		require.False(t, variant)
	}
}

// A variant that moved after the plan is left alone, as is the canonical ref.
func TestCaseVariantRepairRefusesMovedVariant(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	for _, dir := range caseRepairDirs(t) {
		r := newCaseRepo(t, dir)
		r.write(map[string]string{"refs/heads/mythical": r.a}, map[string]string{"refs/heads/Mythical": r.b})
		touched, err := caseVariantRepair{Variant: "refs/heads/Mythical", OID: r.a, Canonical: "refs/heads/mythical",
			Backup: repohost.RefCaseCollisionBackup("t", 0, "refs/heads/Mythical")}.run(context.Background(), r.gitDir)
		require.Error(t, err)
		require.False(t, touched)
		require.Equal(t, map[string]string{"refs/heads/mythical": r.a, "refs/heads/Mythical": r.b}, r.refs())
	}
}

// Backups of two spellings made in one run are two refs on every filesystem.
func TestRefCaseCollisionBackupsAreDistinctFiles(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	for _, dir := range caseRepairDirs(t) {
		r := newCaseRepo(t, dir)
		first := repohost.RefCaseCollisionBackup("t", 0, "refs/heads/Mythical")
		second := repohost.RefCaseCollisionBackup("t", 1, "refs/heads/MYTHICAL")
		require.NoError(t, updateRefs(context.Background(), r.gitDir, "create "+first+"\x00"+r.a+"\x00create "+second+"\x00"+r.b+"\x00"))
		refs := r.refs()
		require.Equal(t, r.a, refs[first])
		require.Equal(t, r.b, refs[second])
	}
}

// The default bookmark only moves forward, and once it has existed a push
// cannot recreate it: with no old value, any commit would pass as its new
// one. A default that never existed is created by a push as usual.
func TestRefuseDefaultBookmarkRewind(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	a, b := "", ""
	main, feature, mythical := "refs/heads/main", "refs/heads/feature", "refs/heads/mythical"
	for _, tc := range []struct {
		name          string
		born          bool
		before, after func() map[string]string
		refused       bool
	}{
		{"forward", false, func() map[string]string { return map[string]string{main: a} }, func() map[string]string { return map[string]string{main: b} }, false},
		{"backward", false, func() map[string]string { return map[string]string{main: b} }, func() map[string]string { return map[string]string{main: a} }, true},
		{"deleted", false, func() map[string]string { return map[string]string{main: a} }, func() map[string]string { return map[string]string{} }, true},
		{"first push", false, func() map[string]string { return map[string]string{} }, func() map[string]string { return map[string]string{main: a} }, false},
		{"new bookmark", false, func() map[string]string { return map[string]string{main: a} }, func() map[string]string { return map[string]string{main: a, feature: b} }, false},
		{"other bookmark rewound", false, func() map[string]string { return map[string]string{main: a, feature: b} }, func() map[string]string { return map[string]string{main: a, feature: a} }, false},
		{"default after another bookmark", false, func() map[string]string { return map[string]string{feature: a, mythical: a} }, func() map[string]string { return map[string]string{feature: a, mythical: a, main: b} }, false},
		{"missing default recreated", true, func() map[string]string { return map[string]string{feature: a} }, func() map[string]string { return map[string]string{feature: a, main: b} }, true},
		{"missing default recreated in an empty repository", true, func() map[string]string { return map[string]string{} }, func() map[string]string { return map[string]string{main: b} }, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := newCaseRepo(t, t.TempDir())
			a, b = r.a, r.b
			if tc.born {
				require.NoError(t, markDefaultBookmarkBorn(r.gitDir, "main"))
			}
			err := refuseDefaultBookmarkRewind(context.Background(), r.gitDir, tc.before(), tc.after())
			if !tc.refused {
				require.NoError(t, err)
				return
			}
			var appErr *appError
			require.True(t, errors.As(err, &appErr), "%v", err)
			require.Equal(t, http.StatusForbidden, appErr.StatusCode)
		})
	}
}

// Another default is not blocked by the marker of an earlier one, and
// switching the default away and back keeps the first one born.
func TestDefaultBookmarkBornNamesEveryDefault(t *testing.T) {
	dir := t.TempDir()
	require.False(t, defaultBookmarkBorn(dir, "main"))
	require.NoError(t, markDefaultBookmarkBorn(dir, "main"))
	require.True(t, defaultBookmarkBorn(dir, "main"))
	require.False(t, defaultBookmarkBorn(dir, "trunk"))
	require.NoError(t, markDefaultBookmarkBorn(dir, "trunk"))
	require.True(t, defaultBookmarkBorn(dir, "trunk"))
	require.True(t, defaultBookmarkBorn(dir, "main"))
	require.False(t, defaultBookmarkBorn(dir, "mai"))
}
