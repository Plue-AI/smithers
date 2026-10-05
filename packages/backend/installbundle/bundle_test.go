package installbundle_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
	"golang.org/x/sys/unix"

	. "github.com/smithersai/smithers/packages/backend/installbundle"
	"github.com/smithersai/smithers/packages/backend/installbundle/bundletest"
)

// fixture writes an installed bundle the way the assembler does: every file
// declared with digest, stage and mode in manifest.json.
func fixture(t *testing.T) string {
	t.Helper()
	root := filepath.Join(bundletest.ProtectedTempDir(t), "libexec")
	for name, file := range map[string]struct {
		body string
		mode os.FileMode
	}{
		"bin/smithers-backend":                         {"approved backend", 0o755},
		"bin/msb":                                      {"#!/bin/sh\necho 'msb 0.0.0'\n", 0o755},
		"bin/libsmithers_ffi.dylib":                    {"approved ffi", 0o755},
		"bin/flow-hosts.json":                          {"{}\n", 0o644},
		"lib/libkrunfw.5.dylib":                        {"approved kernel", 0o644},
		"postgres/root/bin/postgres":                   {"postgres", 0o755},
		"postgres/root/bin/initdb":                     {"initdb", 0o755},
		"postgres/root/share/postgresql/extension.sql": {"data", 0o644},
		"libexec/git-core/git-remote-http":             {"remote helper", 0o755},
		"libexec/git-core/git-sh-setup":                {"shell library", 0o644},
		"share/git-core/templates/description":         {"template", 0o644},
	} {
		target := filepath.Join(root, filepath.FromSlash(name))
		require.NoError(t, os.MkdirAll(filepath.Dir(target), 0o755))
		require.NoError(t, os.WriteFile(target, []byte(file.body), file.mode))
		require.NoError(t, os.Chmod(target, file.mode))
	}
	declare(t, root)
	return root
}

// declare writes manifest.json declaring every regular file now in root.
func declare(t *testing.T, root string) {
	t.Helper()
	var files []map[string]any
	require.NoError(t, filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || entry.Name() == "manifest.json" {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		sum := sha256.Sum256(body)
		files = append(files, map[string]any{"path": filepath.ToSlash(relative), "sha256": hex.EncodeToString(sum[:]), "stage": "fixture", "mode": int(info.Mode().Perm())})
		return nil
	}))
	manifest, err := json.Marshal(map[string]any{"version": 1, "platform": "darwin-arm64", "revision": strings.Repeat("a", 40), "files": files})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(root, "manifest.json"), manifest, 0o644))
}

// Astra and Fable round 1, ruling items 1 and 3: the running backend opens
// only its own protected bundle, with its own bytes as the manifest declares.
func TestOpenRunningPinsTheProtectedBundleAndItsBackend(t *testing.T) {
	for _, test := range []struct {
		name    string
		prepare func(t *testing.T, root string) string // answers the executable
		names   string
	}{
		{name: "approved", prepare: func(_ *testing.T, root string) string { return filepath.Join(root, "bin", "smithers-backend") }},
		{name: "approved through a symlinked ancestor", prepare: func(t *testing.T, root string) string {
			link := filepath.Join(t.TempDir(), "keg")
			require.NoError(t, os.Symlink(filepath.Dir(root), link))
			return filepath.Join(link, filepath.Base(root), "bin", "smithers-backend")
		}},
		{name: "development build", names: "does not run from an installed bundle", prepare: func(t *testing.T, _ string) string {
			outside := filepath.Join(t.TempDir(), "smithers-backend")
			require.NoError(t, os.WriteFile(outside, []byte("approved backend"), 0o755))
			return outside
		}},
		{name: "renamed backend", names: "does not run from an installed bundle", prepare: func(t *testing.T, root string) string {
			renamed := filepath.Join(root, "bin", "backend-dev")
			require.NoError(t, os.Rename(filepath.Join(root, "bin", "smithers-backend"), renamed))
			declare(t, root)
			return renamed
		}},
		{name: "backend bytes changed", names: "bin/smithers-backend differs", prepare: func(t *testing.T, root string) string {
			require.NoError(t, os.WriteFile(filepath.Join(root, "bin", "smithers-backend"), []byte("branch-built backend"), 0o755))
			return filepath.Join(root, "bin", "smithers-backend")
		}},
		{name: "backend undeclared", names: "bin/smithers-backend", prepare: func(t *testing.T, root string) string {
			data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
			require.NoError(t, err)
			var manifest map[string]any
			require.NoError(t, json.Unmarshal(data, &manifest))
			var kept []any
			for _, entry := range manifest["files"].([]any) {
				if entry.(map[string]any)["path"] != BackendPath {
					kept = append(kept, entry)
				}
			}
			manifest["files"] = kept
			data, err = json.Marshal(manifest)
			require.NoError(t, err)
			require.NoError(t, os.WriteFile(filepath.Join(root, "manifest.json"), data, 0o644))
			return filepath.Join(root, "bin", "smithers-backend")
		}},
		{name: "group-writable manifest", names: "manifest.json is not owned", prepare: func(t *testing.T, root string) string {
			require.NoError(t, os.Chmod(filepath.Join(root, "manifest.json"), 0o664))
			return filepath.Join(root, "bin", "smithers-backend")
		}},
		{name: "group-writable bundle directory", names: "libexec is not owned", prepare: func(t *testing.T, root string) string {
			require.NoError(t, os.Chmod(root, 0o775))
			return filepath.Join(root, "bin", "smithers-backend")
		}},
		{name: "world-writable ancestor", names: "is not owned by root or this user", prepare: func(t *testing.T, root string) string {
			require.NoError(t, os.Chmod(filepath.Dir(root), 0o777))
			return filepath.Join(root, "bin", "smithers-backend")
		}},
		{name: "symlinked ancestor whose target is writable", names: "is not owned by root or this user", prepare: func(t *testing.T, root string) string {
			require.NoError(t, os.Chmod(filepath.Dir(root), 0o757))
			link := filepath.Join(t.TempDir(), "keg")
			require.NoError(t, os.Symlink(filepath.Dir(root), link))
			return filepath.Join(link, filepath.Base(root), "bin", "smithers-backend")
		}},
		{name: "group-writable bin directory", names: "bin is not owned", prepare: func(t *testing.T, root string) string {
			require.NoError(t, os.Chmod(filepath.Join(root, "bin"), 0o775))
			return filepath.Join(root, "bin", "smithers-backend")
		}},
		{name: "manifest is a symlink", names: "manifest.json without following links", prepare: func(t *testing.T, root string) string {
			moved := filepath.Join(t.TempDir(), "manifest.json")
			require.NoError(t, os.Rename(filepath.Join(root, "manifest.json"), moved))
			require.NoError(t, os.Symlink(moved, filepath.Join(root, "manifest.json")))
			return filepath.Join(root, "bin", "smithers-backend")
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := fixture(t)
			executable := test.prepare(t, root)
			bundle, err := OpenRunning(executable)
			if test.names == "" {
				require.NoError(t, err)
				require.Equal(t, root, bundle.Root())
				require.Equal(t, strings.Repeat("a", 40), bundle.Revision())
				data, err := os.ReadFile(filepath.Join(root, "manifest.json"))
				require.NoError(t, err)
				sum := sha256.Sum256(data)
				require.Equal(t, hex.EncodeToString(sum[:]), bundle.ManifestSHA256())
				return
			}
			require.Error(t, err)
			require.Nil(t, bundle)
			require.Contains(t, err.Error(), test.names)
		})
	}
}

func TestOpenRefusesInvalidManifests(t *testing.T) {
	entry := `{"path":"bin/x","sha256":"` + strings.Repeat("b", 64) + `","stage":"s","mode":493}`
	valid := func(files string) string {
		return `{"version":1,"platform":"darwin-arm64","revision":"` + strings.Repeat("a", 40) + `","files":[` + files + `]}`
	}
	for name, manifest := range map[string]string{
		"missing":        "",
		"version":        strings.Replace(valid(entry), `"version":1`, `"version":2`, 1),
		"platform":       strings.Replace(valid(entry), "darwin-arm64", "linux-arm64", 1),
		"revision":       strings.Replace(valid(entry), strings.Repeat("a", 40), "main", 1),
		"no files":       valid(""),
		"traversal":      valid(strings.Replace(entry, "bin/x", "bin/../x", 1)),
		"absolute":       valid(strings.Replace(entry, "bin/x", "/bin/x", 1)),
		"duplicate":      valid(entry + "," + entry),
		"digest":         valid(strings.Replace(entry, strings.Repeat("b", 64), strings.Repeat("B", 64), 1)),
		"unknown field":  valid(strings.Replace(entry, `"mode":493`, `"mode":493,"approved":true`, 1)),
		"trailing value": valid(entry) + " {}",
	} {
		t.Run(name, func(t *testing.T) {
			root := bundletest.ProtectedTempDir(t)
			if manifest != "" {
				require.NoError(t, os.WriteFile(filepath.Join(root, "manifest.json"), []byte(manifest), 0o644))
			}
			_, err := Open(root)
			require.ErrorIs(t, err, ErrUnapproved)
		})
	}
	for _, root := range []string{"relative/bundle", "/tmp/../tmp/bundle"} {
		_, err := Open(root)
		require.ErrorIs(t, err, ErrUnapproved, root)
	}
}

// Ruling item 3: a path handed to the backend is the bundle's own member with
// the manifest's bytes, or startup refuses naming the variable and the path.
func TestExpectVerifiesHandedPaths(t *testing.T) {
	root := fixture(t)
	bundle, err := Open(root)
	require.NoError(t, err)
	ffi := filepath.Join(root, "bin", "libsmithers_ffi.dylib")
	path, err := bundle.Expect("SMITHERS_FFI_LIBRARY_PATH", "", "bin/libsmithers_ffi.dylib", false)
	require.NoError(t, err, "unset answers the bundle's own member")
	require.Equal(t, ffi, path)
	path, err = bundle.Expect("SMITHERS_FFI_LIBRARY_PATH", ffi, "bin/libsmithers_ffi.dylib", false)
	require.NoError(t, err)
	require.Equal(t, ffi, path)
	outside := filepath.Join(t.TempDir(), "libsmithers_ffi.dylib")
	require.NoError(t, os.WriteFile(outside, []byte("approved ffi"), 0o755))
	for name, value := range map[string]string{
		"outside the bundle":   outside,
		"relative":             "bin/libsmithers_ffi.dylib",
		"another member":       filepath.Join(root, "bin", "msb"),
		"traversal to outside": root + "/../" + filepath.Base(outside),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := bundle.Expect("SMITHERS_FFI_LIBRARY_PATH", value, "bin/libsmithers_ffi.dylib", false)
			require.ErrorIs(t, err, ErrUnapproved)
			require.Contains(t, err.Error(), "SMITHERS_FFI_LIBRARY_PATH="+value)
		})
	}
	require.NoError(t, os.WriteFile(ffi, []byte("other ffi"), 0o755))
	_, err = bundle.Expect("SMITHERS_FFI_LIBRARY_PATH", ffi, "bin/libsmithers_ffi.dylib", false)
	require.ErrorIs(t, err, ErrUnapproved)
	require.Contains(t, err.Error(), "SMITHERS_FFI_LIBRARY_PATH")
	_, err = bundle.Expect("SMITHERS_NODE_BINARY", "", "bin/flow-hosts.json", true)
	require.ErrorIs(t, err, ErrUnapproved, "a program must be declared executable")
}

func TestExpectProgramsVerifiesEachProgram(t *testing.T) {
	root := fixture(t)
	bundle, err := Open(root)
	require.NoError(t, err)
	directory := filepath.Join(root, "postgres", "root", "bin")
	path, err := bundle.ExpectPrograms("SMITHERS_NATIVE_POSTGRES_BIN", directory, "postgres", "initdb")
	require.NoError(t, err)
	require.Equal(t, directory, path)
	_, err = bundle.ExpectPrograms("SMITHERS_NATIVE_POSTGRES_BIN", directory, "postgres", "pg_dump")
	require.ErrorIs(t, err, ErrUnapproved, "an undeclared program refuses")
	_, err = bundle.ExpectPrograms("SMITHERS_NATIVE_POSTGRES_BIN", t.TempDir(), "postgres")
	require.ErrorContains(t, err, "is not a directory of the installed bundle")
	_, err = bundle.ExpectPrograms("SMITHERS_NATIVE_POSTGRES_BIN", "postgres/root/bin", "postgres")
	require.ErrorContains(t, err, "is not an absolute path")
	require.NoError(t, os.WriteFile(filepath.Join(directory, "initdb"), []byte("branch initdb"), 0o755))
	_, err = bundle.ExpectPrograms("SMITHERS_NATIVE_POSTGRES_BIN", directory, "postgres", "initdb")
	require.ErrorContains(t, err, "postgres/root/bin/initdb differs")
}

// Ruling item 3: a directory of bundle files handed to the backend (git's
// helpers and templates) is exactly the bundle's own directory, and every
// regular file the manifest declares below it has the manifest's bytes.
func TestExpectDirectoryVerifiesEveryDeclaredFile(t *testing.T) {
	root := fixture(t)
	bundle, err := Open(root)
	require.NoError(t, err)
	directory := filepath.Join(root, "libexec", "git-core")
	path, err := bundle.ExpectDirectory("GIT_EXEC_PATH", directory, "libexec/git-core")
	require.NoError(t, err)
	require.Equal(t, directory, path)
	_, err = bundle.ExpectDirectory("GIT_EXEC_PATH", t.TempDir(), "libexec/git-core")
	require.ErrorContains(t, err, "is not the installed bundle's libexec/git-core")
	_, err = bundle.ExpectDirectory("GIT_EXEC_PATH", filepath.Join(root, "libexec"), "libexec/git-core")
	require.ErrorContains(t, err, "is not the installed bundle's libexec/git-core", "another bundle directory refuses")
	_, err = bundle.ExpectDirectory("GIT_EXEC_PATH", "libexec/git-core", "libexec/git-core")
	require.ErrorContains(t, err, "is not an absolute path")
	empty := filepath.Join(root, "share", "git-core", "hooks")
	require.NoError(t, os.MkdirAll(empty, 0o755))
	_, err = bundle.ExpectDirectory("GIT_TEMPLATE_DIR", empty, "share/git-core/hooks")
	require.ErrorContains(t, err, "declares nothing below share/git-core/hooks")
	require.NoError(t, os.WriteFile(filepath.Join(directory, "git-sh-setup"), []byte("branch library"), 0o644))
	_, err = bundle.ExpectDirectory("GIT_EXEC_PATH", directory, "libexec/git-core")
	require.ErrorContains(t, err, "GIT_EXEC_PATH: ")
	require.ErrorContains(t, err, "libexec/git-core/git-sh-setup differs", "a file that is not a program is verified too")
}

// A path a program searches before a declared file holds nothing, not even
// a link, below a protected parent.
func TestAbsent(t *testing.T) {
	root := fixture(t)
	bundle, err := Open(root)
	require.NoError(t, err)
	require.NoError(t, bundle.Absent("bin/libkrunfw.5.dylib"))
	shadow := filepath.Join(root, "bin", "libkrunfw.5.dylib")
	require.NoError(t, os.WriteFile(shadow, []byte("approved kernel"), 0o644))
	require.ErrorContains(t, bundle.Absent("bin/libkrunfw.5.dylib"), "bin/libkrunfw.5.dylib exists")
	require.NoError(t, os.Remove(shadow))
	require.NoError(t, os.Symlink(filepath.Join(root, "lib", "libkrunfw.5.dylib"), shadow))
	require.ErrorContains(t, bundle.Absent("bin/libkrunfw.5.dylib"), "bin/libkrunfw.5.dylib exists", "a link is not absence")
	require.NoError(t, os.Remove(shadow))
	require.NoError(t, os.Chmod(filepath.Join(root, "bin"), 0o775))
	require.ErrorContains(t, bundle.Absent("bin/libkrunfw.5.dylib"), "bin is not owned", "the parent is walked")
}

// A file is verified at each use: changed bytes or mode refuse, the approved
// bytes written back pass, and a library needs no execute bit.
func TestFileIsVerifiedAtEachUse(t *testing.T) {
	root := fixture(t)
	bundle, err := Open(root)
	require.NoError(t, err)
	kernel := bundle.Library("lib/libkrunfw.5.dylib")
	require.NoError(t, kernel.Check())
	require.ErrorIs(t, bundle.Program("lib/libkrunfw.5.dylib").Check(), ErrUnapproved, "a program must be executable in the manifest")
	path := filepath.Join(root, "lib", "libkrunfw.5.dylib")
	require.NoError(t, os.WriteFile(path, []byte("approved kerneL"), 0o644))
	require.ErrorContains(t, kernel.Check(), "lib/libkrunfw.5.dylib differs")
	require.NoError(t, os.WriteFile(path, []byte("approved kernel"), 0o644))
	require.NoError(t, kernel.Check())
	require.NoError(t, os.Chmod(filepath.Join(root, "lib"), 0o775))
	require.ErrorContains(t, kernel.Check(), "lib is not owned", "lib/ is walked like bin/")
}

// Ruling item 3: a host-state directory is absolute and reached through a
// protected chain.
func TestProtectedDirectory(t *testing.T) {
	data := filepath.Join(bundletest.ProtectedTempDir(t), "data")
	require.NoError(t, os.MkdirAll(data, 0o700))
	resolved, err := ProtectedDirectory("SMITHERS_DATA_ROOT", data)
	require.NoError(t, err)
	require.Equal(t, data, resolved)
	link := filepath.Join(t.TempDir(), "state")
	require.NoError(t, os.Symlink(data, link))
	resolved, err = ProtectedDirectory("SMITHERS_DATA_ROOT", link)
	require.NoError(t, err)
	require.Equal(t, data, resolved, "a symlink is resolved once")
	_, err = ProtectedDirectory("SMITHERS_DATA_ROOT", "data")
	require.ErrorContains(t, err, "SMITHERS_DATA_ROOT=data must be an absolute, clean path")
	require.NoError(t, os.Chmod(data, 0o770))
	_, err = ProtectedDirectory("SMITHERS_DATA_ROOT", data)
	require.ErrorContains(t, err, data+" is not owned by root or this user")
	_, err = ProtectedDirectory("SMITHERS_DATA_ROOT", "/tmp")
	require.ErrorContains(t, err, "is not owned by root or this user, or is writable by group or others", "a sticky world-writable directory fails")
}

// The bundle trust rule: root or the running user owns it, and neither group
// nor others can write it.
func TestTrustedOwnership(t *testing.T) {
	uid := uint32(os.Getuid())
	for _, test := range []struct {
		uid  uint32
		mode uint32
		ok   bool
	}{
		{0, 0o755, true}, {uid, 0o700, true}, {uid, 0o755, true},
		{uid + 1, 0o755, uid+1 == 0}, {0, 0o775, false}, {uid, 0o757, false}, {uid, 0o722, false}, {0, 0o1777, false},
	} {
		require.Equal(t, test.ok, TrustedOwnership(test.uid, unix.S_IFDIR|test.mode), "uid %d mode %o", test.uid, test.mode)
	}
}
