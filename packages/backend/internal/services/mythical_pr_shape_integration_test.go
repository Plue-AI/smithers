package services

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/repository"
	"github.com/stretchr/testify/require"
)

// The same publication and accepted-tree reader serve the install's propose
// worker and branch diff route. Repository configuration is hostile data.
func TestMythicalPRPublicationHostileRepositoryConfiguration(t *testing.T) {
	h := newMergeHarness(t)
	f := h.publicationFixture
	item := f.todo("Safe transfer", "publish data", f.main, "SAFE.txt", "safe\n")
	dir := t.TempDir()
	canary := filepath.Join(dir, "executed")
	script := filepath.Join(dir, "program")
	require.NoError(t, os.WriteFile(script, []byte("#!/bin/sh\ntouch "+shellQuote(canary)+"\nexit 1\n"), 0700))
	for _, name := range []string{"pre-push", "pre-receive", "post-receive", "reference-transaction", "post-checkout", "pre-commit"} {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\ntouch "+shellQuote(canary)+"\nexit 1\n"), 0700))
	}
	for key, value := range map[string]string{"core.hooksPath": dir, "diff.external": script, "diff.hostile.command": script, "diff.hostile.textconv": script, "merge.hostile.driver": script + " %O %A %B", "credential.helper": "!" + script, "core.fsmonitor": script, "core.alternateRefsCommand": script} {
		f.git(f.hostDir, "config", key, value)
	}
	require.NoError(t, os.WriteFile(filepath.Join(f.hostDir, "info", "attributes"), []byte("*.txt diff=hostile merge=hostile\n"), 0600))
	f.wake()
	item = f.item(item.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	require.True(t, item.PRNumber.Valid)
	require.Contains(t, h.pull(item.PRNumber.Int64).Body, "publish data")
	_, err := os.Stat(canary)
	require.True(t, os.IsNotExist(err), "publication and accepted-tree reads must not run repository programs")
}

func TestMythicalMergeDisablesRepositoryDrivers(t *testing.T) {
	// Git 2.38 supports merge-tree but predates GIT_ATTR_SOURCE. Exercise
	// command's driver policy without relying on the newer Git safeguard.
	git, err := exec.LookPath("git")
	require.NoError(t, err)
	shim := filepath.Join(t.TempDir(), "git")
	require.NoError(t, os.WriteFile(shim, []byte("#!/bin/sh\nunset GIT_ATTR_SOURCE\ncd "+shellQuote(t.TempDir())+"\nexec "+shellQuote(git)+" \"$@\"\n"), 0700))
	restore, err := hostexec.Configure(hostexec.Config{Git: shim, Environment: hostexec.Environment()})
	require.NoError(t, err)
	t.Cleanup(restore)
	f := newMythicalFixture(t)
	base := f.commit("base", map[string]string{"x.txt": "base\n", ".gitattributes": "*.txt merge=hostile\n"})
	f.run("checkout", "--quiet", "-b", "left")
	left := f.commit("left", map[string]string{"x.txt": "left\n"})
	f.run("checkout", "--quiet", "-b", "right", base)
	right := f.commit("right", map[string]string{"x.txt": "right\n"})
	marker := filepath.Join(t.TempDir(), "executed")
	program := filepath.Join(t.TempDir(), "driver")
	require.NoError(t, os.WriteFile(program, []byte("#!/bin/sh\ntouch "+shellQuote(marker)+"\nexit 1\n"), 0700))
	f.run("config", "merge.hostile.driver", program)
	require.NoError(t, os.WriteFile(filepath.Join(f.git.dir, "info", "attributes"), []byte("*.txt merge=hostile\n"), 0600))
	_, err = f.git.merge3(context.Background(), base, left, right)
	require.NoFileExists(t, marker)
	var conflict *errMythicalConflict
	require.ErrorAs(t, err, &conflict)
	require.Equal(t, []string{"x.txt"}, conflict.Paths)
}

// The install's immutable item-base reader uses the native repository engine,
// never a patch fake. This also checks the host path with executable git config.
func TestMythicalPRNativeAcceptedItemDiff(t *testing.T) {
	library := os.Getenv("SMITHERS_FFI_LIBRARY_PATH")
	if library == "" {
		t.Skip("SMITHERS_FFI_LIBRARY_PATH required for native accepted-tree proof")
	}
	h := newMergeHarness(t)
	f := h.publicationFixture
	first := f.todo("First", "first", f.main, "FIRST.txt", "first\n")
	f.wake()
	first = f.item(first.Number.Int64)
	second := f.todo("Second", "second", first.CandidateHead, "SECOND.txt", "second\n")
	f.wake()
	second = f.item(second.Number.Int64)
	storage := t.TempDir()
	local, err := repository.OpenLocal(repository.Config{StoragePath: storage, AuthToken: "native-pr-proof", FFILibraryPath: library})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, local.Shutdown(context.Background())) })
	client := local.Client()
	require.NoError(t, client.InitRepo(h.ctx, "smithers-canary", "smithers", "main", true))
	nativeStore := filepath.Join(storage, "smithers-canary", "smithers", ".jj", "repo", "store", "git")
	_, err = (mythicalGit{dir: f.hostDir}).command(h.ctx, nil, "push", "--mirror", nativeStore)
	require.NoError(t, err)
	require.NoError(t, client.ImportRefs(h.ctx, "smithers-canary", "smithers"))
	marker := filepath.Join(t.TempDir(), "executed")
	program := filepath.Join(t.TempDir(), "program")
	require.NoError(t, os.WriteFile(program, []byte("#!/bin/sh\ntouch "+shellQuote(marker)+"\nexit 1\n"), 0700))
	for _, path := range []string{nativeStore, f.hostDir} {
		for key, value := range map[string]string{"core.hooksPath": filepath.Dir(program), "diff.external": program, "diff.hostile.textconv": program, "merge.hostile.driver": program, "credential.helper": "!" + program, "core.fsmonitor": program} {
			f.git(path, "config", key, value)
		}
		require.NoError(t, os.WriteFile(filepath.Join(path, "info", "attributes"), []byte("*.txt diff=hostile merge=hostile\n"), 0600))
	}
	f.service.host = client
	diff, err := f.service.TODOBranchDiff(h.ctx, mythicalChecksOf(second).Branch)
	require.NoError(t, err)
	require.Len(t, diff.Files, 1, "the earlier item's file is excluded")
	require.Equal(t, "SECOND.txt", diff.Files[0].Path)
	require.Equal(t, first.CandidateHead, diff.Files[0].Against.Rev)
	require.Equal(t, "item_base", diff.Files[0].Against.Kind)
	require.Equal(t, "+", diff.Files[0].Hunks[0].Lines[0].Op)
	require.Equal(t, "second", diff.Files[0].Hunks[0].Lines[0].Text)
	require.NoFileExists(t, marker)
}

func TestMythicalHostPublicationIgnoresGlobalConfiguration(t *testing.T) {
	f := newMythicalFixture(t)
	base := f.commit("base", map[string]string{"x.txt": "base\n", ".gitattributes": "*.txt merge=hostile\n"})
	f.run("checkout", "--quiet", "-b", "left")
	left := f.commit("left", map[string]string{"x.txt": "left\n"})
	f.run("checkout", "--quiet", "-b", "right", base)
	right := f.commit("right", map[string]string{"x.txt": "right\n"})
	dir := t.TempDir()
	canary := filepath.Join(dir, "executed")
	config := filepath.Join(dir, ".gitconfig")
	require.NoError(t, os.WriteFile(filepath.Join(f.git.dir, "info", "attributes"), []byte("*.txt merge=hostile\n"), 0600))
	// Prove this global driver executes in an ordinary merge, then exercise
	// the same object-only merge used by host publication with that config.
	command := "touch " + shellQuote(canary) + "; exit 1"
	cmd := exec.Command("git", "config", "--file", config, "merge.hostile.driver", command)
	require.NoError(t, cmd.Run())
	cmd = exec.Command("git", "--git-dir", f.git.dir, "merge-tree", "--write-tree", left, right)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+config)
	_, err := cmd.CombinedOutput()
	require.Error(t, err)
	require.FileExists(t, canary, "the global driver must be an executable canary")
	require.NoError(t, os.Remove(canary))
	t.Setenv("GIT_CONFIG_GLOBAL", config)
	t.Setenv("HOME", dir)
	_, err = f.git.merge3(context.Background(), base, left, right)
	var conflict *errMythicalConflict
	require.ErrorAs(t, err, &conflict)
	require.NoFileExists(t, canary)

	h := newMergeHarness(t)
	publication := h.publicationFixture
	item := publication.todo("Safe transfer", "publish data", publication.main, "SAFE.txt", "safe\n")
	for key, value := range map[string]string{
		"user.name": "Hostile", "user.email": "hostile@example.invalid", "user.useConfigOnly": "true",
		"credential.helper": "!" + command, "url.ext::hostile.insteadOf": "http://",
		"safe.directory": "/does-not-exist", "core.sshCommand": command,
		"http.proxy": "http://127.0.0.1:1", "protocol.http.allow": "never", "protocol.https.allow": "never",
	} {
		cmd := exec.Command("git", "config", "--file", config, key, value)
		require.NoError(t, cmd.Run())
	}
	publication.wake()
	item = publication.item(item.Number.Int64)
	require.Equal(t, "proposed", item.State, item.Reason)
	require.True(t, item.PRNumber.Valid)
	published, err := (mythicalGit{dir: publication.github}).readCommit(context.Background(), item.PRHead)
	require.NoError(t, err)
	require.Contains(t, published.Author, "Smithers <smithers@smithers.sh>")
	require.Equal(t, published.Author, published.Committer)
	require.NoFileExists(t, canary, "host publication must ignore the global driver")
	// Local drivers are replaced with false; Git still needs writable merge
	// temporaries in the scratch repository to report the normal conflict.
	f.run("config", "merge.hostile.driver", command)
	_, err = f.git.merge3(context.Background(), base, left, right)
	require.ErrorAs(t, err, &conflict)
	require.NoFileExists(t, canary)
}

func TestMythicalHostMergeDoesNotRenormalize(t *testing.T) {
	f := newMythicalFixture(t)
	base := f.commit("base", map[string]string{"x.txt": "base\n"})
	f.run("checkout", "--quiet", "-b", "left")
	left := f.commit("left", map[string]string{"x.txt": "left\n"})
	f.run("checkout", "--quiet", "-b", "right", base)
	right := f.commit("right", map[string]string{"x.txt": "right\n"})
	canary := filepath.Join(t.TempDir(), "executed")
	f.run("config", "merge.renormalize", "true")
	f.run("config", "filter.hostile.clean", "touch "+shellQuote(canary)+"; cat")
	require.NoError(t, os.WriteFile(filepath.Join(f.git.dir, "info", "attributes"), []byte("*.txt filter=hostile\n"), 0600))
	_, err := f.git.merge3(context.Background(), base, left, right)
	var conflict *errMythicalConflict
	require.ErrorAs(t, err, &conflict)
	require.NoFileExists(t, canary, "bare host merges must not renormalize through repository filters")
}
