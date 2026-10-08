package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
	"github.com/stretchr/testify/require"
)

// Uses the packaged TODO host, production dispatcher, PostgreSQL and GitHub fake.
func TestMemberTodoSponsorRehearsal(t *testing.T) {
	r := newRehearsal(t, "SMITHERS_MEMBER_SPONSOR_REHEARSAL", "C-ACC-03", "member-sponsor-")
	require.True(t, r.install("Install"))
	ben, err := r.member("ben", 201, "write")
	require.NoError(t, err)
	r.j10BuiltinReviewActive()
	file := func(title, prompt string) int64 {
		t.Helper()
		body, err := json.Marshal(map[string]any{"title": title, "prompt": prompt, "place": map[string]string{"mode": "append"}})
		require.NoError(t, err)
		code, data, err := r.keyedAs(ben, "POST", "/api/todos", string(body), r.keyPrefix+title)
		require.NoError(t, err)
		require.Equal(t, 202, code, string(data))
		var receipt struct {
			N int64 `json:"n"`
		}
		require.NoError(t, json.Unmarshal(data, &receipt))
		require.Positive(t, receipt.N)
		return receipt.N
	}
	t.Cleanup(func() { _ = r.release("member-sponsor"); _ = r.release("member-suspend") })
	n := file("Member credential", "[PR] [FILE member.md] [HOLD member-sponsor] Write member.md.")
	require.NoError(t, r.waitHeld("member-sponsor", 3*time.Minute))
	var workspace string
	var sponsor, hostSponsor int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT i.workspace_id,i.owner_id,b.user_id FROM mythical_items i JOIN flow_runtime_host_bindings b ON b.workspace_id::text=i.workspace_id WHERE i.number=$1 ORDER BY b.created_at DESC LIMIT 1`, n).Scan(&workspace, &sponsor, &hostSponsor))
	require.Equal(t, sponsor, hostSponsor)
	var benID int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT id FROM users WHERE lower_username='ben'`).Scan(&benID))
	require.Equal(t, benID, sponsor)
	value, ok := r.hostCredentials.Load(workspace)
	require.True(t, ok)
	token := value.(string)
	digest := sha256.Sum256([]byte(token))
	var mintedSponsor int64
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT user_id FROM access_tokens WHERE token_hash=$1`, hex.EncodeToString(digest[:])).Scan(&mintedSponsor))
	require.Equal(t, benID, mintedSponsor)
	call := func(number int64, status int) {
		t.Helper()
		req, err := http.NewRequest("GET", fmt.Sprintf("%s/api/todos/%d", r.origin, number), nil)
		require.NoError(t, err)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		require.NoError(t, err)
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		require.NoError(t, err)
		require.Equal(t, status, resp.StatusCode, string(data))
	}
	call(n, 200)
	other, err := r.file("Other branch", "[PR] [FILE other.md] Write other.md.")
	require.NoError(t, err)
	call(other, 403)
	require.NoError(t, r.release("member-sponsor"))
	t.Run("member TODO reaches review", func(t *testing.T) {
		_, err := r.waitTodoWithin(n, 4*time.Minute, "in_review")
		require.NoError(t, err)
	})
	// A second active attempt proves sponsor suspension, rather than terminal-token expiry.
	second := file("Suspended member", "[PR] [FILE suspend.md] [HOLD member-suspend] Write suspend.md.")
	require.NoError(t, r.waitHeld("member-suspend", 3*time.Minute))
	require.NoError(t, r.pool.QueryRow(r.ctx, `SELECT workspace_id FROM mythical_items WHERE number=$1`, second).Scan(&workspace))
	value, ok = r.hostCredentials.Load(workspace)
	require.True(t, ok)
	token = value.(string)
	call(second, 200)
	codec, err := webhook.NewSecretCodec("rehearsal-encryption-key")
	require.NoError(t, err)
	credentials := services.NewGitHubAppCredentialStore(r.pool, codec)
	members := &services.Members{Pool: r.pool, Credentials: credentials, Minter: services.NewRepoConnectionService(r.pool, credentials)}
	r.fake.SetCollaborator(201, "ben", "read")
	started := time.Now()
	require.NoError(t, members.Recheck(r.ctx))
	call(second, 401)
	require.LessOrEqual(t, time.Since(started), 5*time.Second)
	require.NoError(t, r.release("member-suspend"))
}
