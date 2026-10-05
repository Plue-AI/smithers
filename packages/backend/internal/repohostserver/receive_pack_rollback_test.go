package repohostserver

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// gitObjectExists reports whether the repository at gitDir stores oid.
func gitObjectExists(gitDir, oid string) bool {
	return exec.Command("git", "--git-dir", gitDir, "cat-file", "-e", oid).Run() == nil
}

// Round 4, admission: a command naming HEAD, another pseudoref or a bare
// name is refused before git runs, for every credential, the sync's
// included. At round 3 git refused only that command of a non-atomic push
// and applied the rest.
func TestReceivePackRefusesPseudorefsBeforeGitForEveryCredential(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			f, tip := installFixture(t, "main")
			f.srv.config.InstallMainMirror = install
			before := rawRefs(t, f.repo.gitDir)
			for _, name := range []string{"HEAD", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "main", "heads/main"} {
				for _, kind := range []string{"person", "sync", "run", "platform"} {
					tag := "refs/tags/" + strings.ToLower(name) + "-" + kind
					body := nonAtomicPushBody(t, f, tip,
						installCommand{laneZeroOID, tip, strings.ReplaceAll(tag, "/heads/main", "")},
						installCommand{f.base, tip, name})
					rec := postReceivePack(t, f, body, repohost.PusherCredentialHeader, kind)
					require.Equal(t, http.StatusBadRequest, rec.Code, "%s %s: %s", kind, name, rec.Body.String())
					assert.Equal(t, before, rawRefs(t, f.repo.gitDir), "%s %s changed refs", kind, name)
				}
			}
			assert.False(t, gitObjectExists(f.repo.gitDir, tip), "a refused push reached git")
		})
	}
}

// Round 4, listing cap: a push whose new refs would carry the ref listing
// past its cap is refused before git applies anything, so the listing that
// checks the push cannot fail for that reason. A push within the cap lands.
func TestReceivePackRefusesListingGrowthBeforeGit(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			f, tip := installFixture(t, "main")
			f.srv.config.InstallMainMirror = install
			before := rawRefs(t, f.repo.gitDir)
			size := int64(0)
			for name, oid := range before {
				size += refListingLineBytes(name, oid)
			}
			one := "refs/tags/" + strings.Repeat("t", 100)
			previous := maxRefListingBytes
			maxRefListingBytes = size + refListingLineBytes(one, tip)
			t.Cleanup(func() { maxRefListingBytes = previous })

			commands := []installCommand{{laneZeroOID, tip, one}, {laneZeroOID, tip, one + "-2"}}
			rec := postReceivePack(t, f, nonAtomicPushBody(t, f, tip, commands...), repohost.PusherCredentialHeader, "person")
			require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code, rec.Body.String())
			assert.Equal(t, repohost.PushTooLargeCode, rec.Header().Get("X-Smithers-Error-Code"))
			assert.Equal(t, before, rawRefs(t, f.repo.gitDir))
			assert.False(t, gitObjectExists(f.repo.gitDir, tip), "the refused pack reached git")

			rec = postReceivePack(t, f, nonAtomicPushBody(t, f, tip, commands[0]), repohost.PusherCredentialHeader, "person")
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			assert.Equal(t, tip, rawRefs(t, f.repo.gitDir)[one])
		})
	}
}

// Fable round 3, R3-2: a refused push is rolled back even when a symbolic
// ref aliases the ref it moved. At round 3 the restore named both the alias
// and its target, git aborted the transaction, and the refused rewrite of
// main stayed applied. On an install the sync's rewrite is refused after git;
// on a hosted repository a person's is.
func TestRefusedPushRollsBackPastSymbolicAlias(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			f, tip := installFixture(t, "main")
			f.srv.config.InstallMainMirror = install
			kind := "person"
			if install {
				kind = "sync"
			}
			rec := postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/main"), repohost.PusherCredentialHeader, kind)
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
			out, err := exec.Command("git", "--git-dir", f.repo.gitDir, "symbolic-ref", "refs/heads/alias", "refs/heads/main").CombinedOutput()
			require.NoError(t, err, string(out))
			f.git("reset", "-q", "--hard", f.base)
			rewrite := f.commit("rewritten", func(dir string) {
				require.NoError(t, os.WriteFile(filepath.Join(dir, "reviewed.txt"), []byte("rewritten\n"), 0o644))
			})

			rec = postReceivePack(t, f, f.pushBody(tip, rewrite, "refs/heads/main"), repohost.PusherCredentialHeader, kind)
			require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
			refs := rawRefs(t, f.repo.gitDir)
			assert.Equal(t, tip, refs["refs/heads/main"], "the refused rewrite stayed applied")
			target, err := exec.Command("git", "--git-dir", f.repo.gitDir, "symbolic-ref", "refs/heads/alias").Output()
			require.NoError(t, err)
			assert.Equal(t, "refs/heads/main", strings.TrimSpace(string(target)), "the rollback replaced the alias")
			assert.NoFileExists(t, filepath.Join(f.repo.gitDir, rollbackHoldFile))
		})
	}
}

// The rollback writes each ref it names, never through a symbolic one, and
// refuses a name repohost.ValidateRefName refuses rather than resolving it.
func TestRestoreGitRefsNeverDereferences(t *testing.T) {
	f := newRestoreFixture(t, 1)
	out, err := exec.Command("git", "--git-dir", f.gitDir, "symbolic-ref", "refs/heads/alias", "refs/heads/main").CombinedOutput()
	require.NoError(t, err, string(out))
	before := f.refs(t)
	require.Equal(t, f.oldOID, before["refs/heads/alias"])
	out, err = exec.Command("git", "--git-dir", f.gitDir, "update-ref", "refs/heads/main", f.newOID).CombinedOutput()
	require.NoError(t, err, string(out))
	after := f.refs(t)

	require.NoError(t, restoreGitRefs(context.Background(), f.gitDir, before, after))
	require.Equal(t, before, f.refs(t))
	target, err := exec.Command("git", "--git-dir", f.gitDir, "symbolic-ref", "refs/heads/alias").Output()
	require.NoError(t, err)
	assert.Equal(t, "refs/heads/main", strings.TrimSpace(string(target)))

	// HEAD names main. A rollback handed HEAD refuses it: by name it would
	// detach HEAD from main, through it it would write main.
	out, err = exec.Command("git", "--git-dir", f.gitDir, "symbolic-ref", "HEAD", "refs/heads/main").CombinedOutput()
	require.NoError(t, err, string(out))
	out, err = exec.Command("git", "--git-dir", f.gitDir, "update-ref", "refs/heads/main", f.newOID).CombinedOutput()
	require.NoError(t, err, string(out))
	require.Error(t, restoreGitRefs(context.Background(), f.gitDir, map[string]string{"HEAD": f.oldOID}, map[string]string{"HEAD": f.newOID}))
	head, err := exec.Command("git", "--git-dir", f.gitDir, "symbolic-ref", "HEAD").Output()
	require.NoError(t, err, "the rollback detached HEAD")
	assert.Equal(t, "refs/heads/main", strings.TrimSpace(string(head)))
	assert.Equal(t, f.newOID, f.refs(t)["refs/heads/main"])
	out, err = exec.Command("git", "--git-dir", f.gitDir, "update-ref", "refs/heads/main", f.oldOID).CombinedOutput()
	require.NoError(t, err, string(out))
	require.Equal(t, before, f.refs(t))

	// A dangling alias drops out of every listing. Restoring it by name
	// must not write the ref it names: the rollback fails instead, which
	// holds the repository.
	out, err = exec.Command("git", "--git-dir", f.gitDir, "symbolic-ref", "refs/heads/stray", "refs/heads/ghost").CombinedOutput()
	require.NoError(t, err, string(out))
	require.Error(t, restoreGitRefs(context.Background(), f.gitDir, map[string]string{"refs/heads/stray": f.oldOID}, map[string]string{}))
	assert.Equal(t, before, f.refs(t), "the rollback wrote through a dangling alias")
}

// Round 4, fail closed: a push whose refs cannot be listed after git applied
// them cannot be checked or rolled back, so nothing is written and every
// write to the repository is held, durably, until the operator restores its
// refs and removes the hold file. Reads proceed. Here a dangling symbolic ref
// makes git create a ref the pre-check could not count.
func TestUnlistablePushHoldsTheRepository(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			f, tip := installFixture(t, "main")
			f.srv.config.InstallMainMirror = install
			out, err := exec.Command("git", "--git-dir", f.repo.gitDir, "symbolic-ref", "refs/heads/alias", "refs/heads/ghost").CombinedOutput()
			require.NoError(t, err, string(out))
			before := rawRefs(t, f.repo.gitDir)
			size := int64(0)
			for name, oid := range before {
				size += refListingLineBytes(name, oid)
			}
			previous := maxRefListingBytes
			maxRefListingBytes = size + refListingLineBytes("refs/heads/alias", tip)
			t.Cleanup(func() { maxRefListingBytes = previous })

			rec := postReceivePack(t, f, f.pushBody(laneZeroOID, tip, "refs/heads/alias"), repohost.PusherCredentialHeader, "person")
			require.Equal(t, http.StatusInternalServerError, rec.Code, rec.Body.String())
			assert.Equal(t, repohost.RollbackHeldCode, rec.Header().Get("X-Smithers-Error-Code"))
			holdFile := filepath.Join(f.repo.gitDir, rollbackHoldFile)
			record, err := os.ReadFile(holdFile)
			require.NoError(t, err)
			assert.Contains(t, string(record), "git ref listing exceeds maximum size")
			assert.Equal(t, before["refs/heads/main"], rawRefs(t, f.repo.gitDir)["refs/heads/main"])
			maxRefListingBytes = previous

			// Every write is refused, by this process and the next.
			repoPath := f.srv.config.RepoPath("alice", "demo")
			rec = postReceivePack(t, f, f.pushBody(f.base, tip, "refs/heads/feature"), repohost.PusherCredentialHeader, "sync")
			require.Equal(t, http.StatusServiceUnavailable, rec.Code, rec.Body.String())
			assert.Equal(t, repohost.RollbackHeldCode, rec.Header().Get("X-Smithers-Error-Code"))
			code, errCode, body := installJSON(t, f, http.MethodPost, "/bookmarks", `{"name":"feature","target_change_id":"x"}`)
			require.Equal(t, http.StatusServiceUnavailable, code, body)
			assert.Equal(t, repohost.RollbackHeldCode, errCode)
			discovery := serveGit(t, f, "/repos/alice/demo/git/info-refs?service=git-receive-pack")
			require.Equal(t, http.StatusServiceUnavailable, discovery.Code, discovery.Body.String())
			assert.Contains(t, discovery.Body.String(), "could not be rolled back")
			require.True(t, newRepoLocker().Held(repoPath), "a restarted repo-host would accept writes")
			read := serveGit(t, f, "/repos/alice/demo/git/info-refs?service=git-upload-pack")
			require.Equal(t, http.StatusOK, read.Code, read.Body.String())

			// The operator restores the refs and removes the file.
			require.NoError(t, os.Remove(holdFile))
			rec = postReceivePack(t, f, f.pushBody(laneZeroOID, tip, "refs/heads/feature"), repohost.PusherCredentialHeader, "person")
			require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		})
	}
}

// serveGit serves one authenticated GET to the repo-host git routes.
func serveGit(t *testing.T, f *laneHTTPFixture, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Authorization", validAuth())
	rec := httptest.NewRecorder()
	f.srv.Handler().ServeHTTP(rec, req)
	return rec
}

// The staged import's receive applies the same admission and, on an
// install, refuses refs/replace/* like every receive: the fresh import
// cannot carry a replacement into the mirror. A held stage is never
// published.
func TestStagedImportReceivePackAdmission(t *testing.T) {
	for _, install := range []bool{true, false} {
		t.Run(fmt.Sprintf("install=%v", install), func(t *testing.T) {
			srv := newTestServerWithMock(t, provisionMock(t, true))
			srv.config.InstallMainMirror = install
			token := strings.Repeat("a7", deleteStageTokenBytes)
			stageProvisionForTest(t, srv, stageProvisionRequest{
				Token: token, OperationType: provisionTypeImport, Owner: "alice", Repo: "mirror", DefaultBookmark: "main",
			}, http.StatusCreated)
			path := "/repos/provision-stages/" + token + "/git/git-receive-pack"
			headers := map[string]string{
				"Authorization": "Bearer " + repohost.StagedProvisionBearer(testAuthToken, token),
				"Content-Type":  "application/x-git-receive-pack-request",
			}
			gitDir := filepath.Join(srv.provisionStageDir(token), provisionRepositoryDir, ".jj", "repo", "store", "git")
			stagedRefs := func() map[string]string {
				refs, err := listGitRefs(t.Context(), gitDir)
				require.NoError(t, err)
				return refs
			}
			for _, ref := range []string{"HEAD", "main", "FETCH_HEAD"} {
				rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, path, bytes.NewReader(stagedImportPushBody(t, ref)), headers)
				routerCovRequireStatus(t, rec, http.StatusBadRequest)
			}
			replace := "refs/replace/" + strings.Repeat("ab", 20)
			rec := routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, path, bytes.NewReader(stagedImportPushBody(t, replace)), headers)
			if install {
				routerCovRequireStatus(t, rec, http.StatusForbidden)
				assert.NotContains(t, stagedRefs(), replace)
			} else {
				routerCovRequireStatus(t, rec, http.StatusOK)
				assert.Contains(t, stagedRefs(), replace)
			}
			rec = routerCovServeWithHeaders(t, srv.Handler(), http.MethodPost, path, bytes.NewReader(stagedImportPushBody(t, "refs/heads/main")), headers)
			routerCovRequireStatus(t, rec, http.StatusOK)

			require.NoError(t, os.WriteFile(filepath.Join(gitDir, rollbackHoldFile), []byte("held\n"), 0o600))
			rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/publish", nil)
			routerCovRequireStatus(t, rec, http.StatusServiceUnavailable)
			assert.NoDirExists(t, srv.config.RepoPath("alice", "mirror"))
		})
	}
}
