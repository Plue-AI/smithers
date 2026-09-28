package workspaceconformance

import (
	"errors"
	"io/fs"
	"path"
	"slices"
	"sort"
	"testing"

	"github.com/smithersai/smithers/packages/backend/workspace"
)

// runPaths checks the shared path contract through a started runtime. Shell
// fixtures are independent of WorkspaceFiles, so paired read/write bugs cannot
// make the initial contents appear correct.
func runPaths(t *testing.T, harness CoreHarness, started workspace.Workspace) {
	runtime := harness.Runtime
	fail := func(format string, args ...any) {
		t.Helper()
		t.Fatalf("%T: "+format, append([]any{runtime}, args...)...)
	}
	problem := func(format string, args ...any) {
		t.Helper()
		t.Errorf("%T: "+format, append([]any{runtime}, args...)...)
	}
	command := func(operation, script string, args ...string) workspace.CommandResult {
		t.Helper()
		result, err := runtime.ExecuteCommand(harness.Context("paths-"+operation), harness.Spec.ID, workspace.Command{
			Args: append([]string{"/bin/sh", "-c", script, "paths-fixture"}, args...),
		})
		if err != nil || result.ExitCode != 0 {
			fail("ExecuteCommand(%s) = %#v, %v; want exit 0", operation, result, err)
		}
		return result
	}
	read := func(name, want string) {
		t.Helper()
		got, err := runtime.ReadFile(harness.Context("paths-read-"+name), harness.Spec.ID, name)
		if err != nil || string(got) != want {
			fail("ReadFile(%q) = %q, %v; want %q", name, got, err, want)
		}
	}
	list := func(directory string, want []string) {
		t.Helper()
		entries, err := runtime.ListFiles(harness.Context("paths-list"), harness.Spec.ID, directory)
		if err != nil {
			fail("ListFiles(%q): %v", directory, err)
		}
		got := make([]string, 0, len(entries))
		for _, entry := range entries {
			got = append(got, entry.Name)
		}
		sort.Strings(got)
		sort.Strings(want)
		if !slices.Equal(got, want) {
			fail("ListFiles(%q) names = %q; want %q", directory, got, want)
		}
	}

	directory := "conformance-paths"
	files := []struct{ name, original, overwritten string }{
		{"report", "plain original\n", "plain overwrite\n"},
		{" report ", "spaced original\n", "spaced overwrite\n"},
		{"report\t", "tabbed original\n", "tabbed overwrite\n"},
	}
	overwrites := make(map[string]string, len(files))
	want := make([]string, 0, len(files))
	for _, file := range files {
		command("plant-"+file.name, `mkdir -p -- "$1" && printf %s "$3" > "$1/$2"`, path.Join(started.Root, directory), file.name, file.original)
		want = append(want, file.name)
		overwrites[file.name] = file.overwritten
	}
	list(directory, append([]string(nil), want...))
	for _, file := range files {
		read(path.Join(directory, file.name), file.original)
	}
	for i, file := range files {
		name := path.Join(directory, file.name)
		if err := runtime.WriteFile(harness.Context("paths-write-"+file.name), harness.Spec.ID, name, []byte(file.overwritten), 0o600); err != nil {
			fail("WriteFile(%q): %v", name, err)
		}
		for j, sibling := range files {
			expected := sibling.original
			if j <= i {
				expected = sibling.overwritten
			}
			read(path.Join(directory, sibling.name), expected)
		}
		list(directory, append([]string(nil), want...))
	}
	missing := path.Join(directory, "missing")
	if _, err := runtime.ReadFile(harness.Context("paths-read-missing"), harness.Spec.ID, missing); !errors.Is(err, fs.ErrNotExist) {
		problem("ReadFile(%q) error = %v; want fs.ErrNotExist", missing, err)
	}
	if err := runtime.RemoveFile(harness.Context("paths-remove-missing"), harness.Spec.ID, missing); !errors.Is(err, fs.ErrNotExist) {
		problem("RemoveFile(%q) error = %v; want fs.ErrNotExist", missing, err)
	}
	for _, file := range files {
		name := path.Join(directory, file.name)
		if err := runtime.RemoveFile(harness.Context("paths-remove-"+file.name), harness.Spec.ID, name); err != nil {
			fail("RemoveFile(%q): %v", name, err)
		}
		remaining := make([]string, 0, len(want)-1)
		for _, sibling := range want {
			if sibling != file.name {
				remaining = append(remaining, sibling)
				read(path.Join(directory, sibling), overwrites[sibling])
			}
		}
		want = remaining
		list(directory, append([]string(nil), want...))
		if _, err := runtime.ReadFile(harness.Context("paths-read-removed"), harness.Spec.ID, name); !errors.Is(err, fs.ErrNotExist) {
			problem("ReadFile(removed %q) error = %v; want fs.ErrNotExist", name, err)
		}
	}

	// TempDir is outside Root in both local and isolated workspaces. Register
	// cleanup before creating anything there, including on a fatal assertion.
	outside := path.Join(started.TempDir, "conformance-paths-outside")
	t.Cleanup(func() {
		result, err := runtime.ExecuteCommand(harness.Context("paths-cleanup"), harness.Spec.ID, workspace.Command{
			Args: []string{"/bin/sh", "-c", `rm -rf -- "$1"`, "paths-cleanup", outside},
		})
		if err != nil || result.ExitCode != 0 {
			problem("outside fixture cleanup = %#v, %v", result, err)
		}
	})
	command("plant-outside", `mkdir -p -- "$1" && printf %s "$2" > "$1/target"`, outside, "outside sentinel\n")
	link := path.Join(started.Root, directory, "outside-link")
	command("link-outside", `ln -s -- "$1" "$2"`, path.Join(outside, "target"), link)
	_ = runtime.WriteFile(harness.Context("paths-write-outside-link"), harness.Spec.ID, path.Join(directory, "outside-link"), []byte("overwrite"), 0o600)
	if got := command("check-outside-write", `cat -- "$1" 2>/dev/null || :`, path.Join(outside, "target")).Stdout; got != "outside sentinel\n" {
		problem("WriteFile(outside symlink) changed target to %q", got)
	}
	// A safe writer may replace the link. Restore it so removal always tests
	// an actual symlink, independently of the adapter's write policy.
	command("restore-outside-link", `rm -f -- "$2" && ln -s -- "$1" "$2"`, path.Join(outside, "target"), link)
	if err := runtime.RemoveFile(harness.Context("paths-remove-outside-link"), harness.Spec.ID, path.Join(directory, "outside-link")); err != nil {
		problem("RemoveFile(outside symlink): %v; want successful unlink", err)
	} else {
		command("check-outside-unlink", `test ! -e "$1" && test ! -L "$1"`, link)
	}
	if got := command("check-outside-target", `cat -- "$1" 2>/dev/null || :`, path.Join(outside, "target")).Stdout; got != "outside sentinel\n" {
		problem("RemoveFile(outside symlink) changed target to %q", got)
	}

	dangling := path.Join(started.Root, directory, "dangling-link")
	command("link-dangling", `ln -s -- "$1" "$2"`, path.Join(outside, "absent"), dangling)
	if err := runtime.RemoveFile(harness.Context("paths-remove-dangling"), harness.Spec.ID, path.Join(directory, "dangling-link")); err != nil {
		problem("RemoveFile(dangling symlink): %v; want successful unlink", err)
	} else {
		command("check-dangling-unlink", `test ! -e "$1" && test ! -L "$1"`, dangling)
	}

	command("plant-directory", `mkdir -p -- "$1/nested" && printf child > "$1/nested/child"`, path.Join(started.Root, directory, "tree"))
	if err := runtime.RemoveFile(harness.Context("paths-remove-tree"), harness.Spec.ID, path.Join(directory, "tree")); err != nil {
		fail("RemoveFile(nonempty directory): %v", err)
	}
	command("check-tree-removed", `test ! -e "$1" && test ! -e "$1/nested/child"`, path.Join(started.Root, directory, "tree"))
	for _, name := range []string{"tree", "tree/nested/child"} {
		if _, err := runtime.ReadFile(harness.Context("paths-read-tree-removed"), harness.Spec.ID, path.Join(directory, name)); !errors.Is(err, fs.ErrNotExist) {
			problem("ReadFile(removed %q) error = %v; want fs.ErrNotExist", name, err)
		}
	}

	command("plant-outside-directory", `mkdir -p -- "$1/directory" && printf child > "$1/directory/child"`, outside)
	dirLink := path.Join(started.Root, directory, "directory-link")
	command("link-directory", `ln -s -- "$1" "$2"`, path.Join(outside, "directory"), dirLink)
	_ = runtime.WriteFile(harness.Context("paths-write-through-parent-link"), harness.Spec.ID, path.Join(directory, "directory-link", "escape"), []byte("escape"), 0o600)
	if got := command("check-parent-escape", `test -e "$1/escape" && printf present || :`, path.Join(outside, "directory")).Stdout; got != "" {
		problem("WriteFile through outside parent symlink created escape file")
	}
	if got := command("check-parent-child", `cat -- "$1/child" 2>/dev/null || :`, path.Join(outside, "directory")).Stdout; got != "child" {
		problem("WriteFile through outside parent symlink changed child to %q", got)
	}
	if err := runtime.RemoveFile(harness.Context("paths-remove-through-parent-link"), harness.Spec.ID, path.Join(directory, "directory-link", "child")); err == nil {
		problem("RemoveFile through outside parent symlink succeeded; want rejection")
	}
	if got := command("check-parent-remove-escape", `cat -- "$1/child" 2>/dev/null || :`, path.Join(outside, "directory")).Stdout; got != "child" {
		problem("RemoveFile through outside parent symlink changed child to %q", got)
	}
	// Restore the outside fixture before checking removal of the link itself.
	command("restore-outside-directory", `printf child > "$1/child" && rm -f -- "$1/escape"`, path.Join(outside, "directory"))
	if err := runtime.RemoveFile(harness.Context("paths-remove-directory-link"), harness.Spec.ID, path.Join(directory, "directory-link")); err != nil {
		problem("RemoveFile(directory symlink): %v; want successful unlink", err)
	} else {
		command("check-directory-unlink", `test ! -e "$1" && test ! -L "$1"`, dirLink)
	}
	if got := command("check-directory-target", `cat -- "$1/child" 2>/dev/null || :`, path.Join(outside, "directory")).Stdout; got != "child" {
		problem("RemoveFile(directory symlink) changed target to %q", got)
	}
}
