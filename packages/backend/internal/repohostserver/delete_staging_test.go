package repohostserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func stageDeleteForTest(t *testing.T, srv *Server, owner, repo, token string) {
	t.Helper()
	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages", routerCovJSONBody(t, stageDeleteRequest{
		Owner: owner,
		Repo:  repo,
		Token: token,
	}))
	routerCovRequireStatus(t, rec, http.StatusCreated)
	var response stageDeleteResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode stage response: %v", err)
	}
	if response.Token != token {
		t.Fatalf("stage token = %q, want %q", response.Token, token)
	}
}

func TestStagedDeleteRestoreMovesRepositoryAndSidecarsBack(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("ab", deleteStageTokenBytes)
	repoPath := srv.config.RepoPath("alice", "demo")
	wikiPath := srv.config.WikiRepoPath("alice", "demo")
	docsPath := srv.config.DocsRepoPath("alice", "demo")
	for _, path := range []string{repoPath, wikiPath, docsPath} {
		mkdirAllT(t, path)
	}
	if err := os.WriteFile(filepath.Join(repoPath, "repository-data"), []byte("keep"), 0o600); err != nil {
		t.Fatalf("write repository data: %v", err)
	}

	stageDeleteForTest(t, srv, "alice", "demo", token)
	for _, path := range []string{repoPath, wikiPath, docsPath} {
		assertExists(t, path, false)
	}
	stageDir := srv.deleteStageDir(token)
	for _, name := range []string{deleteStageRepoDir, deleteStageWikiDir, deleteStageDocsDir} {
		assertExists(t, filepath.Join(stageDir, name), true)
	}

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages/"+token+"/restore", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	for _, path := range []string{repoPath, wikiPath, docsPath} {
		assertExists(t, path, true)
	}
	data, err := os.ReadFile(filepath.Join(repoPath, "repository-data"))
	if err != nil || string(data) != "keep" {
		t.Fatalf("restored repository data = %q, err=%v", data, err)
	}
	assertExists(t, stageDir, false)

	// Completion is idempotent so a lost restore response is safe to retry.
	rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages/"+token+"/restore", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
}

func TestStagedDeleteFinalizeDestroysOnlyTombstone(t *testing.T) {
	var deletedPath string
	mock := &mockFFI{deleteRepoFn: func(path string) error {
		deletedPath = path
		return os.RemoveAll(path)
	}}
	srv := newTestServerWithMock(t, mock)
	token := strings.Repeat("cd", deleteStageTokenBytes)
	repoPath := srv.config.RepoPath("alice", "demo")
	wikiPath := srv.config.WikiRepoPath("alice", "demo")
	docsPath := srv.config.DocsRepoPath("alice", "demo")
	for _, path := range []string{repoPath, wikiPath, docsPath} {
		mkdirAllT(t, path)
	}

	stageDeleteForTest(t, srv, "alice", "demo", token)
	stageDir := srv.deleteStageDir(token)
	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages/"+token+"/finalize", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	if deletedPath != filepath.Join(stageDir, deleteStageRepoDir) {
		t.Fatalf("FFI delete path = %q, want tombstone repository path", deletedPath)
	}
	for _, path := range []string{repoPath, wikiPath, docsPath, stageDir} {
		assertExists(t, path, false)
	}

	// Completion is idempotent so a lost finalize response is safe to retry.
	rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages/"+token+"/finalize", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
}

func TestStageDeleteRetryResumesPartialStageAndIsIdempotent(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("ef", deleteStageTokenBytes)
	stageDir := srv.deleteStageDir(token)
	paths := srv.deleteStagePaths("alice", "demo", stageDir)
	for _, path := range paths {
		mkdirAllT(t, path.live)
	}
	if err := os.MkdirAll(stageDir, 0o700); err != nil {
		t.Fatalf("mkdir stage: %v", err)
	}
	metadata, err := json.Marshal(stagedDeleteMetadata{Token: token, Owner: "alice", Repo: "demo"})
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stageDir, deleteStageMetadataFile), metadata, 0o600); err != nil {
		t.Fatalf("write metadata: %v", err)
	}
	// Simulate a process/response interruption after only the main repository
	// reached the client-owned tombstone.
	if err := os.Rename(paths[0].live, paths[0].staged); err != nil {
		t.Fatalf("partially stage repository: %v", err)
	}

	stageDeleteForTest(t, srv, "alice", "demo", token)
	for _, path := range paths {
		assertExists(t, path.live, false)
		assertExists(t, path.staged, true)
	}
	// Retrying an already-complete stage with the same token/repository is a
	// successful no-op, as required after an ambiguous HTTP response.
	stageDeleteForTest(t, srv, "alice", "demo", token)

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages/"+token+"/restore", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	for _, path := range paths {
		assertExists(t, path.live, true)
	}
}

func TestRestoreWaitsForInFlightStageBeforeCheckingMetadata(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("34", deleteStageTokenBytes)
	stageDir := srv.deleteStageDir(token)
	paths := srv.deleteStagePaths("alice", "demo", stageDir)
	mkdirAllT(t, paths[0].live)

	// Model the stage handler owning the client token while the response is
	// lost. The compensating restore must queue behind this lock instead of
	// observing temporarily absent metadata and returning a premature 204.
	unlockStage, err := srv.locks.Lock(context.Background(), stageDir)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/repos/delete-stages/"+token+"/restore", nil)
	req.Header.Set("Authorization", validAuth())
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		srv.Handler().ServeHTTP(rec, req)
		close(done)
	}()

	deadline := time.Now().Add(time.Second)
	for {
		srv.locks.mu.Lock()
		entry := srv.locks.locks[stageDir]
		waiting := entry != nil && entry.refs >= 2
		srv.locks.mu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			unlockStage()
			t.Fatal("restore did not wait on the in-flight stage token")
		}
		runtime.Gosched()
	}

	if err := os.MkdirAll(stageDir, 0o700); err != nil {
		unlockStage()
		t.Fatalf("mkdir stage: %v", err)
	}
	metadata, err := json.Marshal(stagedDeleteMetadata{Token: token, Owner: "alice", Repo: "demo"})
	if err != nil {
		unlockStage()
		t.Fatalf("marshal metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stageDir, deleteStageMetadataFile), metadata, 0o600); err != nil {
		unlockStage()
		t.Fatalf("write metadata: %v", err)
	}
	if err := os.Rename(paths[0].live, paths[0].staged); err != nil {
		unlockStage()
		t.Fatalf("stage repository: %v", err)
	}
	unlockStage()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("restore remained blocked after stage completed")
	}
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	assertExists(t, paths[0].live, true)
	assertExists(t, stageDir, false)
}

func TestStageDeleteRejectsTokenReuseForDifferentRepository(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("12", deleteStageTokenBytes)
	mkdirAllT(t, srv.config.RepoPath("alice", "demo"))
	stageDeleteForTest(t, srv, "alice", "demo", token)

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages", routerCovJSONBody(t, stageDeleteRequest{
		Owner: "bob",
		Repo:  "other",
		Token: token,
	}))
	routerCovRequireStatus(t, rec, http.StatusConflict)
}

func TestStagedDeleteRejectsInvalidToken(t *testing.T) {
	srv := newTestServer(t)
	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages", routerCovJSONBody(t, stageDeleteRequest{
		Owner: "alice",
		Repo:  "demo",
		Token: "predictable",
	}))
	routerCovRequireStatus(t, rec, http.StatusBadRequest)
}

func TestStagedDeleteCompletionFencesStageThatArrivesLater(t *testing.T) {
	for _, action := range []string{"restore", "finalize"} {
		t.Run(action, func(t *testing.T) {
			srv := newTestServer(t)
			tokenByte := "45"
			if action == "finalize" {
				tokenByte = "67"
			}
			token := strings.Repeat(tokenByte, deleteStageTokenBytes)
			repoPath := srv.config.RepoPath("alice", "demo")
			mkdirAllT(t, repoPath)

			// Model compensation winning while the original stage request is
			// still delayed before it has installed any token journal.
			rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages/"+token+"/"+action, nil)
			routerCovRequireStatus(t, rec, http.StatusNoContent)

			rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/delete-stages", routerCovJSONBody(t, stageDeleteRequest{
				Owner: "alice", Repo: "demo", Token: token,
			}))
			routerCovRequireStatus(t, rec, http.StatusConflict)
			assertExists(t, repoPath, true)
			assertExists(t, srv.deleteStageDir(token), false)
			assertExists(t, filepath.Join(srv.deleteDecisionRoot(), token+".json"), true)
		})
	}
}
