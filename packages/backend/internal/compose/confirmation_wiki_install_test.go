package compose

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestConfirmWikiDeleteComposedInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	q, ctx := db.New(pool), t.Context()
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "wiki-owner", LowerUsername: "wiki-owner", DisplayName: "Owner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := []byte(fmt.Sprintf(`{"owner_login":"wiki-owner","repository_name":"app","repository_id":%d,"last_access_check_at":%q}`, repo.ID, time.Now().UTC().Format(time.RFC3339)))
	for _, key := range []string{"github.repository", "owner.access"} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: binding}))
	}
	cookie := "wiki-owner-cookie"
	digest := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	token := "smithers_" + strings.Repeat("a", 40)
	digest = sha256.Sum256([]byte(token))
	hash := hex.EncodeToString(digest[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "wiki-agent", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "read:repository,write:repository,via:smithers,terminal-session:" + liveAppTurnCredentialFixture(t, pool, owner.ID) + "/1", SystemIssued: true, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, err)
	handler := startSplitProcess(t, Options{ChatHost: unusedChatHost{}})
	call := func(method, path, key string, delegated bool, status int) map[string]any {
		t.Helper()
		request := httptest.NewRequest(method, "http://127.0.0.1:4000"+path, strings.NewReader(`{}`))
		request.RemoteAddr = "127.0.0.1:12345"
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", key)
		request.Header.Set("Origin", "http://127.0.0.1:4000")
		request.Header.Set("X-CSRF-Token", "wiki-csrf")
		request.AddCookie(&http.Cookie{Name: "__csrf", Value: "wiki-csrf"})
		if delegated {
			request.Header.Set("Authorization", "Bearer "+token)
		} else {
			request.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		require.Equal(t, status, response.Code, response.Body.String())
		var result map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result), response.Body.String())
		return result
	}
	for _, visibility := range []string{"public", "private"} {
		t.Run(visibility, func(t *testing.T) {
			page, err := q.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repo.ID, AuthorID: owner.ID, Slug: "home", Title: "Home", Body: "Keep these exact bytes", Visibility: visibility})
			require.NoError(t, err)
			path := "/api/repos/wiki-owner/app/wiki/home?visibility=" + visibility
			request := func(key string) string {
				t.Helper()
				receipt := call("DELETE", path, visibility+key, true, 202)
				require.Len(t, receipt, 2)
				require.Equal(t, "pending", receipt["state"])
				return receipt["confirmation"].(string)
			}
			count := func() int {
				var n int
				require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM wiki_pages WHERE id=$1`, page.ID).Scan(&n))
				return n
			}
			id := request("stale")
			require.Equal(t, id, request("stale"))
			require.Equal(t, 1, count())
			row, err := q.GetMemberConfirmation(ctx, id, owner.ID)
			require.NoError(t, err)
			require.Equal(t, "one_click", row.Kind)
			require.Contains(t, string(row.Payload), "Keep these exact bytes")
			call("POST", "/api/confirmations/"+id+"/approve", "agent-press", true, 403)
			_, err = pool.Exec(ctx, `UPDATE wiki_pages SET revision=revision+1 WHERE id=$1`, page.ID)
			require.NoError(t, err)
			result := call("POST", "/api/confirmations/"+id+"/approve", visibility+"stale-press", false, 409)
			require.Equal(t, "confirmation_resolved", result["code"])
			require.Equal(t, 1, count())
			row, err = q.GetMemberConfirmation(ctx, id, owner.ID)
			require.NoError(t, err)
			require.Equal(t, "expired", row.State)
			id = request("cancel")
			call("POST", "/api/confirmations/"+id+"/deny", visibility+"deny", false, 200)
			require.Equal(t, 1, count())
			id = request("delete")
			_, err = pool.Exec(ctx, `CREATE OR REPLACE FUNCTION reject_wiki_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='approved' THEN RAISE EXCEPTION 'forced approval failure'; END IF; RETURN NEW; END $$;
CREATE TRIGGER reject_wiki_confirmation BEFORE UPDATE ON approvals FOR EACH ROW EXECUTE FUNCTION reject_wiki_confirmation()`)
			require.NoError(t, err)
			call("POST", "/api/confirmations/"+id+"/approve", visibility+"delete-press", false, 503)
			require.Equal(t, 1, count())
			row, err = q.GetMemberConfirmation(ctx, id, owner.ID)
			require.NoError(t, err)
			require.Equal(t, "pending", row.State)
			_, err = pool.Exec(ctx, `DROP TRIGGER reject_wiki_confirmation ON approvals`)
			require.NoError(t, err)
			for range 2 {
				call("POST", "/api/confirmations/"+id+"/approve", visibility+"delete-press", false, 200)
			}
			require.Zero(t, count())
			row, err = q.GetMemberConfirmation(ctx, id, owner.ID)
			require.NoError(t, err)
			require.Equal(t, "approved", row.State)
			// A reused slug is a new subject, even when its revision restarts.
			page, err = q.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repo.ID, AuthorID: owner.ID, Slug: "home", Title: "Replacement", Body: "Keep replacement", Visibility: visibility})
			require.NoError(t, err)
			call("POST", "/api/confirmations/"+id+"/approve", visibility+"delete-press", false, 200)
			require.Equal(t, 1, count(), "an old press cannot delete a replacement page")
			id = request("replacement")
			_, err = pool.Exec(ctx, `DELETE FROM wiki_pages WHERE id=$1`, page.ID)
			require.NoError(t, err)
			page, err = q.CreateWikiPage(ctx, db.CreateWikiPageParams{RepositoryID: repo.ID, AuthorID: owner.ID, Slug: "home", Title: "Another replacement", Body: "Keep again", Visibility: visibility})
			require.NoError(t, err)
			call("POST", "/api/confirmations/"+id+"/approve", visibility+"replacement-press", false, 409)
			require.Equal(t, 1, count())

		})
	}
}
