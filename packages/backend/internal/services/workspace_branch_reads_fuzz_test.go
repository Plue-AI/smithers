package services

import (
	"context"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Every page of the branch list is a window of the whole list: walking the
// pages from 1 yields every branch once, in order; any page or size, however
// large or negative, answers a window (never a panic), and a size outside
// 1 to 100 reads as 30.
func FuzzBranchPage(f *testing.F) {
	for _, seed := range [][3]int{{0, 1, 30}, {7, 1, 30}, {7, 2, 3}, {31, 2, 0}, {5, -4, 101}, {3, math.MaxInt, 100}, {100, math.MaxInt / 2, 99}, {2, 1, math.MinInt}} {
		f.Add(seed[0], seed[1], seed[2])
	}
	f.Fuzz(func(t *testing.T, n, page, perPage int) {
		n = (n%300 + 300) % 300
		all := make([]BranchMachineResponse, n)
		for i := range all {
			all[i].Name = "b" + strconv.Itoa(i)
		}
		got := branchPage(all, page, perPage)
		size := perPage
		if size < 1 || size > 100 {
			size = 30
		}
		if len(got) > size {
			t.Fatalf("page %d of size %d holds %d", page, perPage, len(got))
		}
		if len(got) > 0 {
			first, _ := strconv.Atoi(strings.TrimPrefix(got[0].Name, "b"))
			want := page
			if want < 1 {
				want = 1
			}
			if first != (want-1)*size {
				t.Fatalf("page %d starts at %d, want %d", page, first, (want-1)*size)
			}
			for i, branch := range got {
				if branch.Name != "b"+strconv.Itoa(first+i) {
					t.Fatalf("page %d is not a window: %v", page, got)
				}
			}
		}
		var walked []BranchMachineResponse
		for p := 1; ; p++ {
			window := branchPage(all, p, size)
			if len(window) == 0 {
				break
			}
			walked = append(walked, window...)
		}
		if len(walked) != n {
			t.Fatalf("walking pages of %d yields %d of %d branches", size, len(walked), n)
		}
	})
}

// A branch's diff names every file its change touched, whatever the name
// (spaces, tabs, quotes, non-ASCII, leading dashes, nested directories):
// diff-tree's NUL-separated paths are read back exactly, an added file reads
// as added with its one line, an edited one as modified.
func FuzzBranchDiffFilesNames(f *testing.F) {
	if _, err := exec.LookPath("git"); err != nil {
		f.Skip("git unavailable")
	}
	for _, seed := range []string{"greet.mjs", "a b.txt", "tab\tname", "quote\"d", "ünïcödé.md", "-dash", "dir/sub/file.txt", "back\\slash", "*", "*star?", "[ab].txt", ":(glob)x", "new\nline"} {
		f.Add(seed, "hello")
	}
	f.Fuzz(func(t *testing.T, name, line string) {
		if !branchFuzzPath(name) || strings.ContainsAny(line, "\x00\n\r") {
			t.Skip()
		}
		dir := t.TempDir()
		run := func(args ...string) string {
			cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=Smithers", "-c", "user.email=noreply@smithers.sh", "-c", "core.precomposeunicode=false"}, args...)...)
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("git %v: %v\n%s", args, err, out)
			}
			return strings.TrimSpace(string(out))
		}
		write := func(path, content string) {
			if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0o755); err != nil {
				t.Skip()
			}
			if err := os.WriteFile(filepath.Join(dir, path), []byte(content), 0o644); err != nil {
				t.Skip()
			}
		}
		run("init", "--quiet", "-b", "main")
		write("keep.txt", "one\n")
		run("add", "-A")
		run("commit", "--quiet", "-m", "base")
		base := run("rev-parse", "HEAD")
		write(name, line+"\n")
		write("keep.txt", "two\n")
		run("add", "-A")
		run("commit", "--quiet", "-m", "head")
		head := run("rev-parse", "HEAD")
		g := mythicalGit{dir: filepath.Join(dir, ".git")}
		files, sizes, err := branchDiffFiles(context.Background(), g, base, head)
		if err != nil {
			t.Fatal(err)
		}
		diff, err := ProjectTODOBranchDiff("smithers/fuzz", base, files, sizes)
		if err != nil {
			t.Fatal(err)
		}
		changes := map[string]BranchDiffModel{}
		for _, file := range diff.Files {
			changes[file.Path] = file
		}
		if len(changes) != 2 || changes["keep.txt"].Change != "modified" || changes[name].Change != "added" {
			t.Fatalf("diff of %q: %+v", name, diff.Files)
		}
		added := changes[name]
		if len(added.Hunks) != 1 || len(added.Hunks[0].Lines) != 1 || added.Hunks[0].Lines[0] != (BranchDiffLine{Op: "+", Text: line}) {
			t.Fatalf("added %q: hunks %+v", name, added.Hunks)
		}
	})
}

// branchFuzzPath is a path a repository's tree can hold.
func branchFuzzPath(name string) bool {
	if name == "" || len(name) > 120 || strings.ContainsAny(name, "\x00\r") || strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") || strings.EqualFold(name, "keep.txt") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." || strings.EqualFold(part, ".git") || strings.HasSuffix(part, "\n") {
			return false
		}
	}
	return true
}
