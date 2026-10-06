package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

// The transport/worker test writes the receipt through githubfake. This
// complementary boundary proves the composed install serves its field errors
// after restart, using a literal persisted receipt and a real browser session.
func TestTODOGitHubRefusalFieldsComposedInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "refusalowner", LowerUsername: "refusalowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(fmt.Sprintf(`{"owner_login":"refusalowner","repository_name":"demo","repository_id":%d}`, repo.ID))}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(fmt.Sprintf(`{"owner_login":"refusalowner","repository_name":"demo","repository_id":%d,"last_access_check_at":%q}`, repo.ID, time.Now().UTC().Format(time.RFC3339Nano)))}))
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	digest := sha256.Sum256([]byte("refusal-cookie"))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	head := strings.Repeat("a", 40)
	checks := fmt.Sprintf(`{"branch":"smithers/refusal","land":{"head":%q,"generation":1,"refused":{"code":"github_refused","class":"github","message":"GitHub refuses this merge","at":"2026-10-06T00:00:00Z","errors":[{"message":"protected branch"},{"message":"head changed"}]}}}`, head)
	var number int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO mythical_items(repository_id,source,state,title,generation,owner_id,candidate_verified,candidate_head,pr_head,pr_number,pr_state,checks) VALUES($1,'todo','proposed','Refused',1,$2,true,$3,$3,7,'open',$4) RETURNING number`, repo.ID, owner.ID, head, []byte(checks)).Scan(&number))
	server := httptest.NewServer(startSplitProcess(t, Options{ChatHost: unusedChatHost{}}))
	defer server.Close()
	req, err := http.NewRequest("GET", fmt.Sprintf("%s/api/todos/%d", server.URL, number), nil)
	require.NoError(t, err)
	req.Host = "127.0.0.1:4000"
	req.AddCookie(&http.Cookie{Name: "smithers_session", Value: "refusal-cookie"})
	resp, err := server.Client().Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, 200, resp.StatusCode, string(raw))
	var card struct {
		State string
		Merge json.RawMessage
	}
	require.NoError(t, json.Unmarshal(raw, &card))
	require.Equal(t, "in_review", card.State)
	require.JSONEq(t, `{"state":"blocked","reason":"github","detail":"GitHub refuses this merge","on_github":true,"errors":[{"message":"protected branch"},{"message":"head changed"}]}`, string(card.Merge))
}
