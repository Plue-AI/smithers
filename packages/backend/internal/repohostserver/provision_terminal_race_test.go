package repohostserver

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

func TestProvisionTerminalDecisionRejectsLateStage(t *testing.T) {
	for _, action := range []string{"abort", "finalize"} {
		t.Run(action, func(t *testing.T) {
			srv := newTestServerWithMock(t, provisionMock(t, false))
			token := strings.Repeat("e1", deleteStageTokenBytes)
			request := stageProvisionRequest{
				Token: token, OperationType: provisionTypeInit,
				Owner: "alice", Repo: "demo", DefaultBookmark: "main",
			}
			path := "/repos/provision-stages/" + token + "/" + action
			for range 2 { // a lost terminal response must be retryable
				rec := routerCovServe(t, srv.Handler(), http.MethodPost, path, nil)
				routerCovRequireStatus(t, rec, http.StatusNoContent)
			}
			stageProvisionForTest(t, srv, request, http.StatusConflict)
			if _, err := os.Stat(srv.provisionStageDir(token)); !os.IsNotExist(err) {
				t.Fatalf("late stage recreated journal: stat error = %v", err)
			}
			if _, err := os.Stat(filepath.Join(srv.config.RepoPath("alice", "demo"), "identity")); !os.IsNotExist(err) {
				t.Fatalf("late stage published repository: stat error = %v", err)
			}
		})
	}
}

// A real router request remains alive while its body is delayed across completion.
func TestProvisionDelayedStageRemainsFencedAcrossRestart(t *testing.T) {
	for _, action := range []string{"abort", "finalize"} {
		for _, operation := range []string{provisionTypeInit, provisionTypeFork, provisionTypeImport} {
			for _, occupied := range []bool{false, true} {
				t.Run(action+"/"+operation+"/"+map[bool]string{false: "free", true: "occupied"}[occupied], func(t *testing.T) {
					srv := newTestServerWithMock(t, provisionMock(t, false))
					token := strings.Repeat("e2", deleteStageTokenBytes)
					live := srv.config.RepoPath("alice", "demo")
					if occupied {
						mkdirAllT(t, live)
						if err := os.WriteFile(filepath.Join(live, "unrelated"), []byte("keep"), 0600); err != nil {
							t.Fatal(err)
						}
					}
					request := stageProvisionRequest{Token: token, OperationType: operation, Owner: "alice", Repo: "demo", DefaultBookmark: "main", SrcOwner: "bob", SrcRepo: "source"}
					if operation != provisionTypeFork {
						request.SrcOwner = ""
						request.SrcRepo = ""
					}
					body, err := json.Marshal(request)
					if err != nil {
						t.Fatal(err)
					}
					reader, writer := io.Pipe()
					req := httptest.NewRequest(http.MethodPost, "/repos/provision-stages", reader)
					req.Header.Set("Authorization", "Bearer "+testAuthToken)
					rec := httptest.NewRecorder()
					done := make(chan struct{})
					go func() { srv.Handler().ServeHTTP(rec, req); close(done) }()
					t.Cleanup(func() { reader.Close(); writer.Close() })
					for range 2 {
						terminal := routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/"+action, nil)
						routerCovRequireStatus(t, terminal, http.StatusNoContent)
					}
					if _, err := writer.Write(body); err != nil {
						t.Fatal(err)
					}
					writer.Close()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Fatal("delayed stage did not finish")
					}
					routerCovRequireStatus(t, rec, http.StatusConflict)
					restarted, err := NewWithFFI(srv.config, provisionMock(t, false))
					if err != nil {
						t.Fatal(err)
					}
					stageProvisionForTest(t, restarted, request, http.StatusConflict)
					for _, next := range []string{action, "publish", map[string]string{"abort": "finalize", "finalize": "abort"}[action]} {
						want := http.StatusConflict
						if next == action {
							want = http.StatusNoContent
						}
						routerCovRequireStatus(t, routerCovServe(t, restarted.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/"+next, nil), want)
					}
					assertExists(t, srv.provisionStageDir(token), false)
					assertExists(t, live, occupied)
					if occupied {
						data, err := os.ReadFile(filepath.Join(live, "unrelated"))
						if err != nil || string(data) != "keep" {
							t.Fatalf("destination altered: %q %v", data, err)
						}
					}
				})
			}
		}
	}
}

func TestProvisionRejectedFinalizeDoesNotConsumeToken(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, false))
	token := strings.Repeat("e3", deleteStageTokenBytes)
	request := stageProvisionRequest{Token: token, OperationType: provisionTypeInit, Owner: "alice", Repo: "demo", DefaultBookmark: "main"}
	stageProvisionForTest(t, srv, request, http.StatusCreated)
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/finalize", nil), http.StatusConflict)
	stageProvisionForTest(t, srv, request, http.StatusCreated)
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/publish", nil), http.StatusNoContent)
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost, "/repos/provision-stages/"+token+"/finalize", nil), http.StatusNoContent)
	stageProvisionForTest(t, srv, request, http.StatusConflict)
	assertExists(t, srv.config.RepoPath("alice", "demo"), true)
}

func TestProvisionCompletionRetrySettlesCrashJournalWithoutTouchingReplacement(t *testing.T) {
	for _, action := range []string{"abort", "finalize"} {
		t.Run(action, func(t *testing.T) {
			srv := newTestServerWithMock(t, provisionMock(t, false))
			token := strings.Repeat("e4", deleteStageTokenBytes)
			path := "/repos/provision-stages/" + token + "/" + action
			routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost, path, nil), http.StatusNoContent)
			// Simulate a crash after the durable receipt but before journal removal.
			stage := srv.provisionStageDir(token)
			mkdirAllT(t, stage)
			if err := os.WriteFile(filepath.Join(stage, provisionMetadataFile), []byte("partially removed"), 0600); err != nil {
				t.Fatal(err)
			}
			live := srv.config.RepoPath("alice", "demo")
			mkdirAllT(t, live)
			if err := os.WriteFile(filepath.Join(live, "replacement"), []byte("keep"), 0600); err != nil {
				t.Fatal(err)
			}
			restarted, err := NewWithFFI(srv.config, provisionMock(t, false))
			if err != nil {
				t.Fatal(err)
			}
			routerCovRequireStatus(t, routerCovServe(t, restarted.Handler(), http.MethodPost, path, nil), http.StatusNoContent)
			assertExists(t, stage, false)
			data, err := os.ReadFile(filepath.Join(live, "replacement"))
			if err != nil || string(data) != "keep" {
				t.Fatalf("replacement altered: %q %v", data, err)
			}
		})
	}
}

func TestProvisionCompletionReceiptFailureRemainsRetryable(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, false))
	token := strings.Repeat("e5", deleteStageTokenBytes)
	root := srv.provisionDecisionRoot()
	if err := os.WriteFile(root, []byte("blocked"), 0600); err != nil {
		t.Fatal(err)
	}
	path := "/repos/provision-stages/" + token + "/abort"
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost, path, nil), http.StatusInternalServerError)
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost, path, nil), http.StatusNoContent)
	stageProvisionForTest(t, srv, stageProvisionRequest{Token: token, OperationType: provisionTypeInit, Owner: "alice", Repo: "demo", DefaultBookmark: "main"}, http.StatusConflict)
}

func TestProvisionCompletedImportRefusesTokenScopedGitWrites(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, false))
	token := strings.Repeat("e6", deleteStageTokenBytes)
	stageProvisionForTest(t, srv, stageProvisionRequest{Token: token, OperationType: provisionTypeImport,
		Owner: "alice", Repo: "mirror", DefaultBookmark: "main"}, http.StatusCreated)
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost,
		"/repos/provision-stages/"+token+"/abort", nil), http.StatusNoContent)
	restarted, err := NewWithFFI(srv.config, provisionMock(t, false))
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []struct{ method, path string }{
		{http.MethodGet, "/git/info/refs?service=git-receive-pack"},
		{http.MethodPost, "/git/git-receive-pack"},
	} {
		rec := routerCovServeWithHeaders(t, restarted.Handler(), endpoint.method,
			"/repos/provision-stages/"+token+endpoint.path, nil,
			map[string]string{"Authorization": "Bearer " + repohost.StagedProvisionBearer(testAuthToken, token)})
		routerCovRequireStatus(t, rec, http.StatusConflict)
		if code := rec.Header().Get("X-Smithers-Error-Code"); code != "provision_completed" {
			t.Fatalf("%s completed import error code = %q", endpoint.path, code)
		}
	}
	assertExists(t, srv.provisionStageDir(token), false)
}

func TestProvisionCompletionRetrySettlesReceiptAfterDirectorySyncFailure(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, false))
	token := strings.Repeat("e7", deleteStageTokenBytes)
	request := stageProvisionRequest{Token: token, OperationType: provisionTypeInit,
		Owner: "alice", Repo: "demo", DefaultBookmark: "main"}
	stageProvisionForTest(t, srv, request, http.StatusCreated)
	root := srv.provisionDecisionRoot()
	if err := ensureDurableDirectory(root, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(terminalStageDecision{Token: token, Action: "abort"})
	if err != nil {
		t.Fatal(err)
	}
	// Inject the failure at the actual durable journal primitive used by
	// completion: rename succeeded, but its directory fsync did not.
	failure := errors.New("injected receipt directory sync failure")
	installed, err := writeDurableJournalWithSync(root, token+".json", data, 0o600, func(string) error { return failure })
	if !installed || !errors.Is(err, failure) {
		t.Fatalf("receipt installation = %v, %v", installed, err)
	}
	stageProvisionForTest(t, srv, request, http.StatusConflict)
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost,
		"/repos/provision-stages/"+token+"/abort", nil), http.StatusNoContent)
	assertExists(t, srv.provisionStageDir(token), false)
	decision, exists, err := readTerminalStageDecision(root, token)
	if err != nil || !exists || decision.Action != "abort" {
		t.Fatalf("settled receipt = %+v, %v, %v", decision, exists, err)
	}
}

func TestProvisionCompletedConflictHasRecoveryCode(t *testing.T) {
	srv := newTestServerWithMock(t, provisionMock(t, false))
	token := strings.Repeat("e8", deleteStageTokenBytes)
	path := "/repos/provision-stages/" + token
	routerCovRequireStatus(t, routerCovServe(t, srv.Handler(), http.MethodPost, path+"/abort", nil), http.StatusNoContent)
	request := stageProvisionRequest{Token: token, OperationType: provisionTypeInit, Owner: "alice", Repo: "demo", DefaultBookmark: "main"}
	for _, endpoint := range []struct {
		path string
		body io.Reader
	}{
		{"/repos/provision-stages", routerCovJSONBody(t, request)},
		{path + "/publish", nil},
		{path + "/finalize", nil},
	} {
		rec := routerCovServe(t, srv.Handler(), http.MethodPost, endpoint.path, endpoint.body)
		routerCovRequireStatus(t, rec, http.StatusConflict)
		var envelope errorEnvelope
		if err := json.NewDecoder(rec.Body).Decode(&envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Code != "provision_completed" {
			t.Fatalf("completed token conflict code = %q, want provision_completed", envelope.Code)
		}
	}
}

func TestProvisionCompletedRealClientTransportAndTerminalIdempotency(t *testing.T) {
	for _, action := range []string{"abort", "finalize"} {
		t.Run(action, func(t *testing.T) {
			srv := newTestServerWithMock(t, provisionMock(t, false))
			server := httptest.NewServer(srv.Handler())
			defer server.Close()
			client := repohost.NewClient(&repohost.StaticStorageSetResolver{URL: server.URL}, testAuthToken)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			staged := repohost.StagedProvision{BaseURL: server.URL, StorageSetID: "test-storage", Token: strings.Repeat("e9", deleteStageTokenBytes), OperationType: provisionTypeInit, Owner: "alice", Repo: "demo", DefaultBookmark: "main"}
			if err := client.ExecuteStagedProvision(ctx, staged); err != nil {
				t.Fatal(err)
			}
			if action == "finalize" {
				if err := client.PublishStagedProvision(ctx, staged); err != nil {
					t.Fatal(err)
				}
				if err := client.FinalizeStagedProvision(ctx, staged); err != nil {
					t.Fatal(err)
				}
			} else if err := client.AbortStagedProvision(ctx, staged); err != nil {
				t.Fatal(err)
			}
			assertCompleted := func(err error) {
				t.Helper()
				var status *repohost.StatusError
				if !errors.As(err, &status) || status.StatusCode != http.StatusConflict || status.Code != "provision_completed" {
					t.Fatalf("client completed conflict = %#v, want StatusError 409 provision_completed", err)
				}
			}
			assertCompleted(client.ExecuteStagedProvision(ctx, staged))
			for range 2 {
				err := client.AbortStagedProvision(ctx, staged)
				if action == "finalize" {
					assertCompleted(err)
				} else if err != nil {
					t.Fatal(err)
				}
			}
			assertExists(t, srv.provisionStageDir(staged.Token), false)
			assertExists(t, srv.config.RepoPath(staged.Owner, staged.Repo), action == "finalize")
			decision, exists, err := readTerminalStageDecision(srv.provisionDecisionRoot(), staged.Token)
			if err != nil || !exists || decision.Action != action {
				t.Fatalf("terminal receipt = %+v, %v, %v", decision, exists, err)
			}
		})
	}
}
