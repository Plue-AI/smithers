package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

// Component qualification of the production TODO HTTP projection. This is not
// C-J8-04's real-machine dispatcher/selector qualification.
func TestPlanWikiCitationsComposedTodoRoute(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "wiki-owner", LowerUsername: "wiki-owner"})
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "app", LowerName: "app", DefaultBookmark: "main"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE users SET is_active=true WHERE id=$1`, owner.ID)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(singleton,user_id) VALUES(true,$1)`, owner.ID)
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("wiki-browser"))
	_, err = pool.Exec(ctx, `INSERT INTO auth_sessions(session_key,user_id,username,expires_at) VALUES($1,$2,$3,NOW()+interval '1 hour')`, hex.EncodeToString(sum[:]), owner.ID, owner.Username)
	require.NoError(t, err)
	_, err = q.RequestMythicalBootstrap(ctx, repo.ID, owner.ID, 1, false)
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_stacks SET state='active' WHERE repository_id=$1`, repo.ID)
	require.NoError(t, err)
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"wiki-owner","repository_name":"app","repository_id":100}`)}))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "owner.access", Value: []byte(`{"last_access_check_at":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","owner_login":"wiki-owner","repository_name":"app","repository_id":100}`)}))
	service := services.NewMythicalService(pool, nil)
	filed, err := service.FileTodo(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &owner, SessionHash: "wiki-browser"}), repo.ID, owner.ID, services.MythicalTodoInput{Title: "Retry deliveries", Prompt: "Retry failed webhook deliveries", Request: "wiki"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `UPDATE mythical_items SET attempt=2,candidate_head='second',plan=$2,checks=$3 WHERE repository_id=$1`, repo.ID,
		`{"wikiCitations":[{"slug":"retry-policy","pageID":"42","revision":7,"digest":"0b2889240d13d49add99a1daef222ddce288814a94826dbce1fbf456f03adc6b"}]}`,
		`{"attempts":[{"attempt":1,"revision":"first","items":[{"kind":"wiki","slug":"retry-policy","pageID":"42","revision":3,"digest":"0590d40eefc0d1d5a9a5c8d407e4acfcb1cae6de15729033c56dc64ddb9abe47"}]}]}`)
	require.NoError(t, err)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://smithers.test"
	cfg.Server.AllowedOrigins = []string{"http://smithers.test"}
	router := todoMergeComposeRouter(cfg, q, pool, &routes.MythicalHandler{Service: service})
	request := httptest.NewRequest("GET", "http://smithers.test/api/todos/"+strconv.FormatInt(filed.Number, 10), nil)
	request.AddCookie(&http.Cookie{Name: "smithers_session", Value: "wiki-browser"})
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	require.Equal(t, 200, response.Code, response.Body.String())
	var card struct {
		Evidence []struct {
			Attempt int `json:"attempt"`
			Items   []struct {
				Kind     string `json:"kind"`
				Revision int    `json:"revision"`
				URL      string `json:"url"`
			} `json:"items"`
		} `json:"evidence"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &card))
	require.Len(t, card.Evidence, 2)
	require.Equal(t, 3, card.Evidence[0].Items[0].Revision)
	require.Equal(t, "/api/repos/wiki-owner/app/wiki/history/42/3/content?visibility=public", card.Evidence[0].Items[0].URL)
	require.Equal(t, 7, card.Evidence[1].Items[0].Revision)
	require.Equal(t, "/api/repos/wiki-owner/app/wiki/history/42/7/content?visibility=public", card.Evidence[1].Items[0].URL)
}
