package services

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runWorkspaceCloneScript runs the VM clone script against a local remote
// with real git and jj, the agent user and clone path redirected to temp.
func runWorkspaceCloneScript(t *testing.T, remote, bookmark string, rewrite ...func(string) string) (string, string, error) {
	t.Helper()
	for _, tool := range []string{"bash", "git", "jj"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s not installed", tool)
		}
	}
	dir := t.TempDir()
	clone := filepath.Join(dir, "workspace")
	home := filepath.Join(dir, "home")
	require := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	require(os.MkdirAll(filepath.Join(home, ".config"), 0o755))
	script := buildWorkspaceCloneCommand("file://"+remote, "tok", bookmark, 0, workspaceCloneSource{})
	for _, transform := range rewrite {
		script = transform(script)
	}
	asDev := "runuser -u " + shellQuote(defaultWorkspaceUser) + " -- "
	if !strings.Contains(script, asDev) || !strings.Contains(script, workspaceRuntimeReadyCommand()) {
		t.Fatalf("script shape changed:\n%s", script)
	}
	script = strings.ReplaceAll(script, workspaceRuntimeReadyCommand(), "true")
	script = strings.ReplaceAll(script, asDev, "")
	script = strings.ReplaceAll(script, shellQuote(defaultWorkspaceClonePath), shellQuote(clone))
	script = strings.ReplaceAll(script, shellQuote(defaultWorkspaceHome+"/.config"), shellQuote(filepath.Join(home, ".config")))
	script = strings.ReplaceAll(script, shellQuote(defaultWorkspaceHome), shellQuote(home))
	script = strings.ReplaceAll(script, "install -d -o "+shellQuote(defaultWorkspaceUser)+" -g "+shellQuote(defaultWorkspaceUser)+" ", "install -d ")
	cmd := exec.Command("bash", "-c", "(\nset -e\n"+script+"\n)")
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "JJ_USER=t", "JJ_EMAIL=t@example.test")
	out, err := cmd.CombinedOutput()
	return clone, string(out), err
}

func gitIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.test", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.test")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func bareRemote(t *testing.T, branch string) string {
	t.Helper()
	remote := filepath.Join(t.TempDir(), "remote.git")
	gitIn(t, filepath.Dir(remote), "init", "-q", "--bare", "-b", "main", remote)
	if branch != "" {
		work := filepath.Join(t.TempDir(), "work")
		gitIn(t, filepath.Dir(work), "init", "-q", "-b", branch, work)
		gitIn(t, work, "commit", "-q", "--allow-empty", "-m", "first")
		gitIn(t, work, "push", "-q", remote, branch)
	}
	return remote
}

// #3253: a repository created and never pushed provisions a VM workspace on
// an unborn branch named after the bookmark, colocated with Jujutsu.
func TestWorkspaceCloneCommandProvisionsEmptyRepository(t *testing.T) {
	clone, out, err := runWorkspaceCloneScript(t, bareRemote(t, ""), "trunk")
	if err != nil {
		t.Fatalf("empty repository clone failed: %v\n%s", err, out)
	}
	if head := gitIn(t, clone, "symbolic-ref", "HEAD"); head != "refs/heads/trunk" {
		t.Fatalf("HEAD = %q, want refs/heads/trunk", head)
	}
	if _, err := os.Stat(filepath.Join(clone, ".jj")); err != nil {
		t.Fatalf("jj not colocated: %v", err)
	}
	if refs := gitIn(t, clone, "for-each-ref", "refs/remotes/origin/"); refs != "" {
		t.Fatalf("empty clone has remote refs: %s", refs)
	}
}

// A populated repository still checks out its bookmark, and one without the
// requested bookmark still fails closed.
func TestWorkspaceCloneCommandPopulatedRepository(t *testing.T) {
	remote := bareRemote(t, "main")
	clone, out, err := runWorkspaceCloneScript(t, remote, "main")
	if err != nil {
		t.Fatalf("populated clone failed: %v\n%s", err, out)
	}
	if got, want := gitIn(t, clone, "rev-parse", "origin/main"), gitIn(t, remote, "rev-parse", "main"); got != want {
		t.Fatalf("origin/main = %s, want %s", got, want)
	}
	if _, err := os.Stat(filepath.Join(clone, ".jj")); err != nil {
		t.Fatalf("jj not colocated: %v", err)
	}

	_, out, err = runWorkspaceCloneScript(t, remote, "missing")
	if err == nil {
		t.Fatalf("clone of a missing bookmark succeeded:\n%s", out)
	}
	if !strings.Contains(out, "missing") {
		t.Fatalf("failure does not name the bookmark:\n%s", out)
	}
}

// An advertisement that fails (unreachable or refused) fails the clone
// instead of reading as an empty repository.
func TestWorkspaceCloneCommandFailsWhenAdvertisementFails(t *testing.T) {
	clone, out, err := runWorkspaceCloneScript(t, filepath.Join(t.TempDir(), "absent.git"), "main")
	if err == nil {
		t.Fatalf("clone of an unreachable remote succeeded:\n%s", out)
	}
	if _, statErr := os.Stat(clone); !os.IsNotExist(statErr) {
		t.Fatalf("unreachable remote left a working copy: %v", statErr)
	}
}

// A tag pushed after the empty advertisement still makes the source populated.
// Its missing bookmark must fail through the ordinary branch checkout.
func TestWorkspaceCloneCommandTagArrivesAfterEmptyAdvertisement(t *testing.T) {
	remote := bareRemote(t, "main")
	gitIn(t, remote, "tag", "first", "main")
	gitIn(t, remote, "update-ref", "-d", "refs/heads/main")
	_, out, err := runWorkspaceCloneScript(t, remote, "missing", func(script string) string {
		// Reproduce the advertisement/clone race deterministically: Git clones
		// the real tag-only remote after observing an earlier empty snapshot.
		lines := strings.Split(script, "\n")
		advertisements := 0
		for i, line := range lines {
			if strings.HasPrefix(line, "source_refs=") {
				lines[i] = `source_refs=""`
				advertisements++
			}
		}
		if advertisements != 1 {
			t.Fatalf("advertisement assignments = %d, want 1", advertisements)
		}
		return strings.Join(lines, "\n")
	})
	if err == nil {
		t.Fatalf("clone of a tag-only remote with a missing bookmark succeeded:\n%s", out)
	}
	if !strings.Contains(out, "missing") {
		t.Fatalf("failure does not name the bookmark:\n%s", out)
	}
}
