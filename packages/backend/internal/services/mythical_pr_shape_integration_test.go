package services

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

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

func TestMythicalCompletionCloseLostResponseUsesCanonicalReceipt(t *testing.T) {
	f := newPublicationFixture(t, false, 12)
	ctx := context.Background()
	number := f.fake.OpenIssue("rehearsal-owner/app", "rehearsal-owner", "Complete", "Prompt")
	path := fmt.Sprintf("/repos/rehearsal-owner/app/issues/%d", number)
	gh, err := f.service.github.Resolve(ctx, mustPublicationRepository(t, f), "smithers-canary", f.userID)
	require.NoError(t, err)
	api := f.service.github.(*mythicalGitHubAPI)
	since := time.Now().Add(-time.Minute)
	f.fake.OnNextRequest("PATCH", path, func() { f.fake.LoseNextResponses(path, 1) })
	require.Error(t, api.CloseIssueSince(ctx, gh, number, since))
	issue, ok := f.fake.Issue("rehearsal-owner/app", number)
	require.True(t, ok)
	require.Equal(t, "closed", issue.State)
	require.NoError(t, api.CloseIssueSince(ctx, gh, number, since))
	count := 0
	for _, write := range f.fake.Writes() {
		if write.Method == "PATCH" && write.Path == path {
			count++
		}
	}
	require.Equal(t, 1, count, "remote success before acknowledgement must not repeat the close")
}

func TestMythicalMergeDisablesRepositoryDrivers(t *testing.T) {
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
	_, err := f.git.merge3(context.Background(), base, left, right)
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
	var nativeStore string
	require.NoError(t, func() error {
		path := filepath.Join(storage, "smithers-canary", "smithers", ".jj", "repo", "store", "git")
		nativeStore = path
		_, err := (mythicalGit{dir: f.hostDir}).command(h.ctx, nil, "push", "--mirror", path)
		return err
	}())
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
