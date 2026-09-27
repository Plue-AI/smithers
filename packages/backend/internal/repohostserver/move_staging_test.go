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

func stageMoveForTest(t *testing.T, srv *Server, request moveRepoRequest) {
	t.Helper()
	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages", routerCovJSONBody(t, request))
	routerCovRequireStatus(t, rec, http.StatusCreated)
	var response stageMoveResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatalf("decode stage move response: %v", err)
	}
	if response.Token != request.Token {
		t.Fatalf("stage move token = %q, want %q", response.Token, request.Token)
	}
}

func TestStagedMoveRollbackRestoresRepositoryAndSidecars(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("56", deleteStageTokenBytes)
	metadata := stagedMoveMetadata{SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"}
	paths := srv.stagedMovePaths(metadata)
	for _, path := range paths {
		mkdirAllT(t, path.source)
	}
	if err := os.WriteFile(filepath.Join(paths[0].source, "data"), []byte("keep"), 0o600); err != nil {
		t.Fatalf("write repository data: %v", err)
	}
	request := moveRepoRequest{
		SrcOwner: metadata.SrcOwner, SrcRepo: metadata.SrcRepo,
		DstOwner: metadata.DstOwner, DstRepo: metadata.DstRepo, Token: token,
	}

	stageMoveForTest(t, srv, request)
	for _, path := range paths {
		assertExists(t, path.source, false)
		assertExists(t, path.destination, true)
	}
	// A stage retry after an ambiguous response is a successful no-op.
	stageMoveForTest(t, srv, request)

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages/"+token+"/rollback", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	for _, path := range paths {
		assertExists(t, path.source, true)
		assertExists(t, path.destination, false)
	}
	data, err := os.ReadFile(filepath.Join(paths[0].source, "data"))
	if err != nil || string(data) != "keep" {
		t.Fatalf("restored repository data = %q, err=%v", data, err)
	}
	assertExists(t, srv.moveStageDir(token), false)

	// Completion is idempotent when its response is lost.
	rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages/"+token+"/rollback", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
}

func TestStagedMoveFinalizeKeepsDestinationAndRemovesJournal(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("78", deleteStageTokenBytes)
	metadata := stagedMoveMetadata{SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"}
	paths := srv.stagedMovePaths(metadata)
	mkdirAllT(t, paths[0].source)
	stageMoveForTest(t, srv, moveRepoRequest{
		SrcOwner: metadata.SrcOwner, SrcRepo: metadata.SrcRepo,
		DstOwner: metadata.DstOwner, DstRepo: metadata.DstRepo, Token: token,
	})

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages/"+token+"/finalize", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	assertExists(t, paths[0].source, false)
	assertExists(t, paths[0].destination, true)
	assertExists(t, srv.moveStageDir(token), false)

	rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages/"+token+"/finalize", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
}

func TestStageMoveRetryCompletesPartialSidecarMove(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("9a", deleteStageTokenBytes)
	metadata := stagedMoveMetadata{Token: token, SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"}
	paths := srv.stagedMovePaths(metadata)
	for _, path := range paths {
		mkdirAllT(t, path.source)
	}
	stageDir := srv.moveStageDir(token)
	if err := os.MkdirAll(stageDir, 0o700); err != nil {
		t.Fatalf("mkdir move stage: %v", err)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stageDir, moveStageMetadataFile), encoded, 0o600); err != nil {
		t.Fatalf("write move metadata: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(paths[0].destination), 0o755); err != nil {
		t.Fatalf("mkdir destination owner: %v", err)
	}
	// Simulate a process stop after the primary repository rename but before
	// either sidecar reached the destination.
	if err := os.Rename(paths[0].source, paths[0].destination); err != nil {
		t.Fatalf("partially move repository: %v", err)
	}

	stageMoveForTest(t, srv, moveRepoRequest{
		SrcOwner: metadata.SrcOwner, SrcRepo: metadata.SrcRepo,
		DstOwner: metadata.DstOwner, DstRepo: metadata.DstRepo, Token: token,
	})
	for _, path := range paths {
		assertExists(t, path.source, false)
		assertExists(t, path.destination, true)
	}
}

func TestStageMoveRejectsTokenReuseForDifferentMove(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("bc", deleteStageTokenBytes)
	mkdirAllT(t, srv.config.RepoPath("alice", "demo"))
	stageMoveForTest(t, srv, moveRepoRequest{
		SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo", Token: token,
	})
	mkdirAllT(t, srv.config.RepoPath("carol", "other"))
	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages", routerCovJSONBody(t, moveRepoRequest{
		SrcOwner: "carol", SrcRepo: "other", DstOwner: "dave", DstRepo: "other", Token: token,
	}))
	routerCovRequireStatus(t, rec, http.StatusConflict)
}

func TestStagedMoveRollbackWaitsForInFlightStageBeforeCheckingMetadata(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("de", deleteStageTokenBytes)
	metadata := stagedMoveMetadata{Token: token, SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"}
	paths := srv.stagedMovePaths(metadata)
	mkdirAllT(t, paths[0].source)
	stageDir := srv.moveStageDir(token)

	// Model a stage handler that owns the token while its response is being
	// lost. Rollback must wait until the journal and rename are both visible,
	// rather than observing absent metadata and returning a premature 204.
	unlockStage, err := srv.locks.Lock(context.Background(), stageDir)
	require.NoError(t, err)
	req := httptest.NewRequest(http.MethodPost, "/repos/move-stages/"+token+"/rollback", nil)
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
			t.Fatal("rollback did not wait on the in-flight move stage token")
		}
		runtime.Gosched()
	}

	if err := os.MkdirAll(stageDir, 0o700); err != nil {
		unlockStage()
		t.Fatalf("mkdir move stage: %v", err)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		unlockStage()
		t.Fatalf("marshal move metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stageDir, moveStageMetadataFile), encoded, 0o600); err != nil {
		unlockStage()
		t.Fatalf("write move metadata: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(paths[0].destination), 0o755); err != nil {
		unlockStage()
		t.Fatalf("mkdir move destination: %v", err)
	}
	if err := os.Rename(paths[0].source, paths[0].destination); err != nil {
		unlockStage()
		t.Fatalf("move repository: %v", err)
	}
	unlockStage()

	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("rollback remained blocked after the move stage completed")
	}
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	assertExists(t, paths[0].source, true)
	assertExists(t, paths[0].destination, false)
	assertExists(t, stageDir, false)
}

func TestFreshStagedMoveRejectsExistingDestination(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("24", deleteStageTokenBytes)
	metadata := stagedMoveMetadata{Token: token, SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"}
	paths := srv.stagedMovePaths(metadata)
	mkdirAllT(t, paths[0].destination)
	if err := os.WriteFile(filepath.Join(paths[0].destination, "unrelated"), []byte("keep"), 0o600); err != nil {
		t.Fatalf("write destination data: %v", err)
	}

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages", routerCovJSONBody(t, moveRepoRequest{
		SrcOwner: metadata.SrcOwner, SrcRepo: metadata.SrcRepo,
		DstOwner: metadata.DstOwner, DstRepo: metadata.DstRepo, Token: token,
	}))
	routerCovRequireStatus(t, rec, http.StatusConflict)
	assertExists(t, srv.moveStageDir(token), false)

	// A later compensating rollback for the rejected token must not adopt the
	// destination and move it into the absent source namespace.
	rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages/"+token+"/rollback", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	assertExists(t, paths[0].source, false)
	assertExists(t, filepath.Join(paths[0].destination, "unrelated"), true)
}

func TestStagedMoveRollbackRecoversJournalWithMissingDestinationParent(t *testing.T) {
	srv := newTestServer(t)
	token := strings.Repeat("35", deleteStageTokenBytes)
	metadata := stagedMoveMetadata{Token: token, SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"}
	paths := srv.stagedMovePaths(metadata)
	mkdirAllT(t, paths[0].source)
	stageDir := srv.moveStageDir(token)
	mkdirAllT(t, stageDir)
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	if err := os.WriteFile(filepath.Join(stageDir, moveStageMetadataFile), encoded, 0o600); err != nil {
		t.Fatalf("write metadata: %v", err)
	}
	assertExists(t, filepath.Dir(paths[0].destination), false)

	rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages/"+token+"/rollback", nil)
	routerCovRequireStatus(t, rec, http.StatusNoContent)
	assertExists(t, paths[0].source, true)
	assertExists(t, paths[0].destination, false)
	assertExists(t, stageDir, false)
}

func TestStagedMoveCompletionFencesStageThatArrivesLater(t *testing.T) {
	for _, action := range []string{"rollback", "finalize"} {
		t.Run(action, func(t *testing.T) {
			srv := newTestServer(t)
			tokenByte := "46"
			if action == "finalize" {
				tokenByte = "57"
			}
			token := strings.Repeat(tokenByte, deleteStageTokenBytes)
			metadata := stagedMoveMetadata{Token: token, SrcOwner: "alice", SrcRepo: "demo", DstOwner: "bob", DstRepo: "demo"}
			paths := srv.stagedMovePaths(metadata)
			mkdirAllT(t, paths[0].source)

			rec := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages/"+token+"/"+action, nil)
			routerCovRequireStatus(t, rec, http.StatusNoContent)

			rec = routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/move-stages", routerCovJSONBody(t, moveRepoRequest{
				SrcOwner: metadata.SrcOwner, SrcRepo: metadata.SrcRepo,
				DstOwner: metadata.DstOwner, DstRepo: metadata.DstRepo, Token: token,
			}))
			routerCovRequireStatus(t, rec, http.StatusConflict)
			assertExists(t, paths[0].source, true)
			assertExists(t, paths[0].destination, false)
			assertExists(t, srv.moveStageDir(token), false)
			assertExists(t, filepath.Join(srv.moveDecisionRoot(), token+".json"), true)
		})
	}
}
