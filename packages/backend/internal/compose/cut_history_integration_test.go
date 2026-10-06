package compose

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/repohostserver"
	"github.com/stretchr/testify/require"
)

// Historical output lives in the real journal; authentication and the install
// router decide which member may read it. The app uses its shipped HTTP loader.
func TestCutHistoryInstallEarlierMemberPrivacy(t *testing.T) {
	t.Setenv("SMITHERS_TEST_DATABASE_NAMESPACE", "fr2_t_cut_04")
	if _, err := repohostserver.FFILibraryPath(); err != nil {
		t.Skipf("composed install requires the native wiki/repository library: %v", err)
	}
	_, _, pool := splitProcessDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	ben, err := q.CreateUser(ctx, db.CreateUserParams{Username: "ben", LowerUsername: "ben", DisplayName: "Ben"})
	require.NoError(t, err)
	alice, err := q.CreateUser(ctx, db.CreateUserParams{Username: "alice", LowerUsername: "alice", DisplayName: "Alice"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES ($1)`, ben.ID)
	require.NoError(t, err)
	benToken, _ := isolationToken(t, q, ben, "cut-ben")
	aliceToken, _ := isolationToken(t, q, alice, "cut-alice")
	store, err := chat.NewStore(pool)
	require.NoError(t, err)
	root, err := filepath.Abs("../../../..")
	require.NoError(t, err)
	raw, err := os.ReadFile(filepath.Join(root, "apps/app/src/mainview/state/testdata/cut-history.json"))
	require.NoError(t, err)
	var fixture struct {
		Replay struct {
			Page struct {
				Batches []chat.Batch `json:"batches"`
			} `json:"page"`
		} `json:"replay"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	scope := chat.Scope{UserID: ben.ID, Owner: "ben"}
	admitted, err := store.Admit(ctx, chat.AdmitInput{Scope: scope, RunID: "legacy-turn", Journal: chat.JournalRequest{Version: 1, LegID: "legacy-leg", Token: strings.Repeat("a", 48)}, Request: json.RawMessage(`{"conversationId":"legacy-journal","messages":[{"role":"user","content":"Old prompt"}]}`)})
	require.NoError(t, err)
	grant, err := store.Claim(ctx, scope, admitted.TurnID, time.Minute)
	require.NoError(t, err)
	_, err = store.Commit(ctx, chat.CommitInput{TurnID: grant.TurnID, Generation: grant.Generation, Token: grant.Token, Expected: grant.Cursor, Frames: fixture.Replay.Page.Batches[0].Frames})
	require.NoError(t, err)
	server := httptest.NewServer(startSplitProcess(t, Options{}))
	defer server.Close()
	request := func(token, method, path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		r.Host = "127.0.0.1:4000"
		w := httptest.NewRecorder()
		server.Config.Handler.ServeHTTP(w, r)
		return w
	}
	require.Equal(t, http.StatusUnauthorized, request("", "GET", chat.HistoryPath, "").Code)
	benIndex := request(benToken, "GET", chat.HistoryPath, "")
	require.Equal(t, http.StatusOK, benIndex.Code, benIndex.Body.String())
	require.Contains(t, benIndex.Body.String(), "legacy-journal")
	aliceIndex := request(aliceToken, "GET", chat.HistoryPath, "")
	require.Equal(t, http.StatusOK, aliceIndex.Code, aliceIndex.Body.String())
	require.NotContains(t, aliceIndex.Body.String(), "legacy-journal")
	require.Equal(t, http.StatusNotFound, request(aliceToken, "POST", chat.AccountReplayPath, `{"runId":"legacy-turn","legId":"legacy-leg"}`).Code)
	browserCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	browser := exec.CommandContext(browserCtx, "bun", "test", "--isolate", "apps/app/src/mainview/state/BranchNavigationApp.test.tsx", "--test-name-pattern", "Earlier verifies seven historical")
	browser.Dir = root
	browser.Env = append(os.Environ(), "SMITHERS_CUT_HISTORY_ORIGIN="+server.URL, "SMITHERS_CUT_HISTORY_BEN="+benToken, "SMITHERS_CUT_HISTORY_ALICE="+aliceToken)
	output, err := browser.CombinedOutput()
	t.Logf("Earlier app boundary: %s", output)
	require.NoError(t, err)
}
