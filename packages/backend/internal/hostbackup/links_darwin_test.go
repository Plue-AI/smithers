//go:build darwin

package hostbackup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// These cases use the kernel clone the install uses, so a link reaches the
// snapshot exactly as production captures it.

var linkFixtureTime = time.Date(2026, 10, 7, 1, 2, 3, 0, time.UTC)

const linkFixtureBackup = "1.2.3-20261007T010203.000000000Z"

// linkState seeds a state tree with one file and the given links.
func linkState(t *testing.T, links map[string]string) string {
	t.Helper()
	state := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(state, "workspaces/run"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(state, "workspaces/run/file"), []byte("x"), 0600))
	for name, target := range links {
		require.NoError(t, os.MkdirAll(filepath.Dir(filepath.Join(state, name)), 0700))
		require.NoError(t, os.Symlink(target, filepath.Join(state, name)))
	}
	return state
}

func linkBackup(t *testing.T, state, bundle string) (string, *backupAuthorityFixture, error) {
	t.Helper()
	authority := &backupAuthorityFixture{at: linkFixtureTime}
	dir, err := Backup(t.Context(), BackupConfig{FreeSpaceFloor: testFreeSpaceFloor, State: state, Bundle: bundle, Version: Version{"1.2.3", 2, 18}, Authority: authority, Cloner: APFSCloner{}})
	return dir, authority, err
}

func manifestLinks(t *testing.T, dir string) map[string]string {
	t.Helper()
	manifest, err := VerifySnapshot(dir)
	require.NoError(t, err)
	links := map[string]string{}
	for _, file := range manifest.Files {
		if file.Link != "" {
			require.Zero(t, file.Size)
			require.Empty(t, file.SHA256)
			links[file.Path] = file.Link
		}
	}
	return links
}

// Link confinement: a link inside the tree is captured and restored with its
// target, and one that leads out (absolute, a climb, a climb through another
// link, a loop) is never published.
func TestBackupConfinesStateLinks(t *testing.T) {
	t.Run("in-tree relative links restore", func(t *testing.T) {
		state := linkState(t, map[string]string{"workspaces/run/readme": "../run/file", "workspaces/run/self": "."})
		dir, _, err := linkBackup(t, state, "")
		require.NoError(t, err)
		require.Equal(t, linkFixtureBackup, filepath.Base(dir))
		require.Equal(t, map[string]string{"state/workspaces/run/readme": "../run/file", "state/workspaces/run/self": "."}, manifestLinks(t, dir))

		restored := filepath.Join(t.TempDir(), "Smithers")
		authority := &restoreAuthorityFixture{}
		_, err = Restore(t.Context(), RestoreConfig{State: restored, Backup: dir, Version: Version{"1.3.0", 3, 18}, Authority: authority, Cloner: APFSCloner{}})
		require.NoError(t, err)
		target, err := os.Readlink(filepath.Join(restored, "workspaces/run/readme"))
		require.NoError(t, err)
		require.Equal(t, "../run/file", target)
		target, err = os.Readlink(filepath.Join(restored, "workspaces/run/self"))
		require.NoError(t, err)
		require.Equal(t, ".", target)
		bytes, err := os.ReadFile(filepath.Join(restored, "workspaces/run/readme"))
		require.NoError(t, err)
		require.Equal(t, "x", string(bytes))
	})
	for _, tc := range []struct {
		name    string
		links   map[string]string
		refused string
	}{
		{"absolute", map[string]string{"repositories": "/etc"}, "unsafe_path: state/repositories"},
		{"relative climb", map[string]string{"blobs/escape": "../../outside"}, "unsafe_path: state/blobs/escape"},
		{"climb through a link", map[string]string{"workspaces/here": ".", "workspaces/escape": "here/run/../../.."}, "unsafe_path: state/workspaces/escape"},
		{"loop", map[string]string{"workspaces/a": "b"}, "unsafe_path: state/workspaces/a"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.name == "loop" {
				tc.links["workspaces/b"] = "a"
			}
			state := linkState(t, tc.links)
			dir, authority, err := linkBackup(t, state, "")
			if tc.name == "loop" {
				// Either link of a loop is refused, whichever is walked first.
				require.Error(t, err)
				require.Regexp(t, `^unsafe_path: state/workspaces/[ab]$`, err.Error())
			} else {
				require.EqualError(t, err, tc.refused)
			}
			require.Empty(t, dir)
			published, err := filepath.Glob(filepath.Join(state, "backups", "1.2.3-*"))
			require.NoError(t, err)
			require.Empty(t, published)
			require.Equal(t, "reopen", authority.calls[len(authority.calls)-1])
		})
	}
}

// craft adds one entry to a published backup and records it in its manifest,
// as an attacker who can write the backup would.
func craft(t *testing.T, dir string, entry File, make func()) {
	t.Helper()
	make()
	raw, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
	require.NoError(t, err)
	var manifest Manifest
	require.NoError(t, json.Unmarshal(raw, &manifest))
	manifest.Files = append(manifest.Files, entry)
	raw, err = json.Marshal(manifest)
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "MANIFEST.json"), raw, 0600))
}

// A crafted backup must not publish a link that leads out of the state root.
// Restore refuses it before the database is loaded or any live tree moves.
func TestRestoreRefusesCraftedLinksBeforeMovingLiveData(t *testing.T) {
	for _, tc := range []struct {
		name, path, target, refused string
	}{
		{"absolute", "state/repositories", "/etc", "unsafe_path: state/repositories"},
		{"relative climb", "state/workspaces/escape", "../../outside", "unsafe_path: state/workspaces/escape"},
		{"climb through a link", "state/workspaces/escape", "run/self/../../..", "unsafe_path: state/workspaces/escape"},
		{"into the bundle", "state/workspaces/bundle", "../../bundle", "unsafe_path: state/workspaces/bundle"},
		{"beside the trees", "escape", "state/workspaces/run/file", "unsafe_path: escape"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := linkState(t, map[string]string{"workspaces/run/self": "."})
			dir, _, err := linkBackup(t, source, "")
			require.NoError(t, err)
			outside := filepath.Join(filepath.Dir(dir), "outside")
			require.NoError(t, os.WriteFile(outside, []byte("outside bytes"), 0640))
			craft(t, dir, File{Path: tc.path, Link: tc.target}, func() {
				require.NoError(t, os.Symlink(tc.target, filepath.Join(dir, tc.path)))
			})

			_, err = VerifySnapshot(dir)
			require.EqualError(t, err, tc.refused)

			live := t.TempDir()
			require.NoError(t, os.WriteFile(filepath.Join(live, "secret"), []byte("live secret"), 0600))
			authority := &restoreAuthorityFixture{}
			_, err = Restore(t.Context(), RestoreConfig{State: live, Backup: dir, Version: Version{"1.3.0", 3, 18}, Authority: authority, Cloner: APFSCloner{}})
			require.EqualError(t, err, tc.refused)
			require.Empty(t, authority.calls, "refused before the stopped check, the database load and the start")
			entries, err := os.ReadDir(live)
			require.NoError(t, err)
			require.Len(t, entries, 1)
			bytes, err := os.ReadFile(filepath.Join(live, "secret"))
			require.NoError(t, err)
			require.Equal(t, "live secret", string(bytes))
			bytes, err = os.ReadFile(outside)
			require.NoError(t, err)
			require.Equal(t, "outside bytes", string(bytes))
			info, err := os.Lstat(outside)
			require.NoError(t, err)
			require.Equal(t, os.FileMode(0640), info.Mode().Perm())
		})
	}
}

// The manifest is not the oracle for a link: the snapshot's own entries are
// read again, and a recorded link that carries bytes is refused.
func TestSnapshotLinkEntriesMustMatchTheManifest(t *testing.T) {
	published := func(t *testing.T) string {
		dir, _, err := linkBackup(t, linkState(t, map[string]string{"workspaces/run/readme": "../run/file"}), "")
		require.NoError(t, err)
		return dir
	}
	t.Run("retargeted inside the tree", func(t *testing.T) {
		dir := published(t)
		link := filepath.Join(dir, "state/workspaces/run/readme")
		require.NoError(t, os.Remove(link))
		require.NoError(t, os.Symlink("file", link))
		_, err := VerifySnapshot(dir)
		require.EqualError(t, err, "hash_mismatch: state/workspaces/run/readme")
	})
	t.Run("replaced by a file", func(t *testing.T) {
		dir := published(t)
		link := filepath.Join(dir, "state/workspaces/run/readme")
		require.NoError(t, os.Remove(link))
		require.NoError(t, os.WriteFile(link, nil, 0600))
		_, err := VerifySnapshot(dir)
		require.EqualError(t, err, "hash_mismatch: state/workspaces/run/readme")
	})
	t.Run("removed", func(t *testing.T) {
		dir := published(t)
		require.NoError(t, os.Remove(filepath.Join(dir, "state/workspaces/run/readme")))
		_, err := VerifySnapshot(dir)
		require.EqualError(t, err, "missing_file: state/workspaces/run/readme")
	})
	t.Run("added", func(t *testing.T) {
		dir := published(t)
		require.NoError(t, os.Symlink("file", filepath.Join(dir, "state/workspaces/run/extra")))
		_, err := VerifySnapshot(dir)
		require.EqualError(t, err, "extra_file: state/workspaces/run/extra")
	})
	for name, edit := range map[string]func(*File){
		"recorded with bytes":      func(f *File) { f.Size = 1 },
		"recorded with a digest":   func(f *File) { f.SHA256 = strings.Repeat("0", 64) },
		"recorded absolute target": func(f *File) { f.Link = "/etc/passwd" },
	} {
		t.Run(name, func(t *testing.T) {
			dir := published(t)
			raw, err := os.ReadFile(filepath.Join(dir, "MANIFEST.json"))
			require.NoError(t, err)
			var manifest Manifest
			require.NoError(t, json.Unmarshal(raw, &manifest))
			edited := false
			for i := range manifest.Files {
				if manifest.Files[i].Path == "state/workspaces/run/readme" {
					edit(&manifest.Files[i])
					edited = true
				}
			}
			require.True(t, edited)
			raw, err = json.Marshal(manifest)
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(dir, "MANIFEST.json"), raw, 0600))
			_, err = VerifySnapshot(dir)
			require.EqualError(t, err, "unsafe_path: state/workspaces/run/readme")
		})
	}
}

// linkBundle is a release bundle with the two link shapes a real server
// bundle holds: libexec/git-core/<tool> → ../../bin/git and a sibling name.
func linkBundle(t *testing.T) string {
	t.Helper()
	bundle := filepath.Join(t.TempDir(), "libexec")
	for _, dir := range []string{"bin", "libexec/git-core", "postgres/lib"} {
		require.NoError(t, os.MkdirAll(filepath.Join(bundle, dir), 0700))
	}
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "bin/git"), []byte("git program"), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(bundle, "postgres/lib/libpq.5.18.dylib"), []byte("libpq"), 0600))
	require.NoError(t, os.Symlink("../../bin/git", filepath.Join(bundle, "libexec/git-core/git-fetch")))
	require.NoError(t, os.Symlink("libpq.5.18.dylib", filepath.Join(bundle, "postgres/lib/libpq.5.dylib")))
	return bundle
}

// An upgrade's backup holds the running bundle, whose tool links stay inside
// it. They are captured with their targets and restored, so the previous
// version runs from the backup after Homebrew removes its keg.
func TestUpgradeBackupCapturesBundleLinks(t *testing.T) {
	state := linkState(t, nil)
	bundle := linkBundle(t)
	dir, _, err := linkBackup(t, state, bundle)
	require.NoError(t, err)
	require.Equal(t, map[string]string{
		"bundle/libexec/git-core/git-fetch": "../../bin/git",
		"bundle/postgres/lib/libpq.5.dylib": "libpq.5.18.dylib",
	}, manifestLinks(t, dir))

	restored := filepath.Join(t.TempDir(), "Smithers")
	authority := &restoreAuthorityFixture{onStart: func(selected string) {
		require.Equal(t, filepath.Join(restored, "bundle"), selected)
	}}
	_, err = Restore(t.Context(), RestoreConfig{State: restored, Backup: dir, Version: Version{"1.3.0", 3, 18}, Authority: authority, Cloner: APFSCloner{}})
	require.NoError(t, err)
	require.Equal(t, []string{"stopped", "isolation", "database", "start"}, authority.calls)
	target, err := os.Readlink(filepath.Join(restored, "bundle/libexec/git-core/git-fetch"))
	require.NoError(t, err)
	require.Equal(t, "../../bin/git", target)
	bytes, err := os.ReadFile(filepath.Join(restored, "bundle/libexec/git-core/git-fetch"))
	require.NoError(t, err)
	require.Equal(t, "git program", string(bytes))
	bytes, err = os.ReadFile(filepath.Join(restored, "bundle/postgres/lib/libpq.5.dylib"))
	require.NoError(t, err)
	require.Equal(t, "libpq", string(bytes))
	info, err := os.Stat(filepath.Join(restored, "bundle/bin/git"))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0700), info.Mode().Perm())
}

// A bundle link that leaves the bundle refuses before the install freezes.
func TestUpgradeBackupRefusesBundleLinksThatLeaveTheBundle(t *testing.T) {
	for name, target := range map[string]string{
		"into state": "../../state/config/secrets.json",
		"absolute":   "/etc/passwd",
		"above":      "../..",
	} {
		t.Run(name, func(t *testing.T) {
			state := linkState(t, nil)
			bundle := linkBundle(t)
			require.NoError(t, os.Symlink(target, filepath.Join(bundle, "bin/escape")))
			dir, authority, err := linkBackup(t, state, bundle)
			require.EqualError(t, err, "unsafe_path: bin/escape")
			require.Empty(t, dir)
			require.Equal(t, []string{"check", "size"}, authority.calls)
			require.NoDirExists(t, filepath.Join(state, "backups"))
		})
	}
}
