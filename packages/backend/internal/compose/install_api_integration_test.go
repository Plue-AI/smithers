package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/chat"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// everyInstallMember admits every account, so the TODO routes' own
// authorization is what decides; services covers the member boundary.
type everyInstallMember struct{}

func (everyInstallMember) AuthorizeMember(context.Context, int64) *pkgerrors.APIError { return nil }

// A host-run command reads the install's TODOs and flows through the routes
// the person's browser reads, mounted once (mountTodoReads, mountFlowReads),
// and each route decides for the turn's credential as it decides for the
// browser.
func TestInstallAPIReadsTodosThroughTheirOwnRoutes(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	user := func(name string) db.User {
		created, err := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, err)
		return created
	}
	owner, member := user("acme"), user("maya")
	_, err := pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	var repository int64
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO repositories(user_id,name,lower_name,default_bookmark,is_public) VALUES ($1,'app','app','main',false) RETURNING id`, owner.ID).Scan(&repository))
	require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: "github.repository", Value: []byte(`{"owner_login":"acme","repository_name":"app","repository_id":42}`)}))
	revision, _ := json.Marshal([]map[string]any{{"text": "Add a greeting to JOURNEY.md", "acceptance": []string{}, "by": map[string]any{"kind": "person", "login": "acme", "name": "", "avatar_url": "https://avatars.example/acme.png", "color_index": 0}, "at": "2026-10-04T12:00:00Z"}})
	item, err := q.InsertMythicalTodo(ctx, repository, owner.ID, "Add a greeting", "Add a greeting to JOURNEY.md", revision, json.RawMessage(`{"todo":true}`))
	require.NoError(t, err)
	require.EqualValues(t, 1, item.Number.Int64)

	session := func(user db.User) middleware.Credential {
		sum := sha256.Sum256([]byte(uuid.NewString()))
		key := hex.EncodeToString(sum[:])
		_, err := q.CreateAuthSession(ctx, db.CreateAuthSessionParams{SessionKey: key, UserID: user.ID, Username: user.Username, ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		return middleware.Credential{SessionHash: key}
	}
	api := services.InstallAPI{Pool: pool, Members: everyInstallMember{}, Routes: installReadRoutes(q, services.NewMythicalService(pool, nil))}
	read := func(credential middleware.Credential, userID int64, path string) (int, map[string]any, []map[string]any) {
		t.Helper()
		answer, err := api.Call(ctx, credential, userID, http.MethodGet, path)
		require.NoError(t, err, path)
		var one map[string]any
		var many []map[string]any
		if json.Unmarshal(answer.Body, &one) != nil {
			require.NoError(t, json.Unmarshal(answer.Body, &many), path)
		}
		return answer.Status, one, many
	}

	ownerSession := session(owner)
	status, _, list := read(ownerSession, owner.ID, "/api/todos")
	require.Equal(t, http.StatusOK, status)
	require.Len(t, list, 1)
	require.Equal(t, map[string]any{"n": float64(1), "title": "Add a greeting", "state": "queued"}, map[string]any{"n": list[0]["n"], "title": list[0]["title"], "state": list[0]["state"]})
	status, todo, _ := read(ownerSession, owner.ID, "/api/todos/1")
	require.Equal(t, http.StatusOK, status)
	require.Equal(t, "Add a greeting", todo["title"])
	// The flow catalog reads through the same mount: the built-in TODO flow,
	// not a system flow, with one Active version.
	status, _, flows := read(ownerSession, owner.ID, "/api/flows")
	require.Equal(t, http.StatusOK, status)
	require.Len(t, flows, 1)
	require.Equal(t, "todo", flows[0]["name"])
	require.Equal(t, map[string]any{"builtin": true}, flows[0]["source"])
	require.Equal(t, false, flows[0]["system"])
	require.Len(t, flows[0]["versions"], 1)
	require.Equal(t, "active", flows[0]["versions"].([]any)[0].(map[string]any)["state"])
	status, refusal, _ := read(ownerSession, owner.ID, "/api/todos/2")
	require.Equal(t, http.StatusNotFound, status)
	require.Equal(t, "todo_not_found", refusal["code"])
	status, refusal, _ = read(ownerSession, owner.ID, "/api/todos/0")
	require.Equal(t, http.StatusBadRequest, status)
	require.Equal(t, "invalid_todo", refusal["code"])

	// The routes admit a person's browser session on the roster only: a token,
	// even the owner's, and the session of a person off the roster are refused
	// by the route itself (services.Authorize).
	sum := sha256.Sum256([]byte(uuid.NewString()))
	hash := hex.EncodeToString(sum[:])
	_, err = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: owner.ID, Name: "turn", TokenHash: hash, TokenLastEight: hash[:8], Scopes: "read:repository,write:repository,write:user", ExpiresAt: pgtype.Timestamptz{}})
	require.NoError(t, err)
	for _, asker := range []struct {
		credential middleware.Credential
		userID     int64
		message    string
	}{{middleware.Credential{TokenHash: hash}, owner.ID, "Sign in with a browser session"}, {session(member), member.ID, "Not a member"}} {
		for _, path := range []string{"/api/todos", "/api/flows"} {
			status, refusal, _ = read(asker.credential, asker.userID, path)
			require.Equal(t, http.StatusForbidden, status, path)
			require.Equal(t, map[string]any{"class": "permission", "code": "permission", "message": asker.message}, refusal, path)
		}
	}
	// The read is a request of its own: made from inside the producer
	// callback, itself a routed POST, it is routed afresh and never inherits
	// that route's method, path or values.
	callback := chi.NewRouter()
	callback.Post(chat.APICallPath, func(w http.ResponseWriter, r *http.Request) {
		answer, err := api.Call(r.Context(), ownerSession, owner.ID, http.MethodGet, "/api/todos/1")
		require.NoError(t, err)
		w.WriteHeader(answer.Status)
		_, _ = w.Write(answer.Body)
	})
	routed := httptest.NewRecorder()
	callback.ServeHTTP(routed, httptest.NewRequest(http.MethodPost, chat.APICallPath, nil))
	require.Equal(t, http.StatusOK, routed.Code, routed.Body.String())
	require.Contains(t, routed.Body.String(), `"title":"Add a greeting"`)
	// Writes and other routes are not the command's to reach.
	_, err = api.Call(ctx, ownerSession, owner.ID, http.MethodPost, "/api/todos")
	require.ErrorIs(t, err, services.ErrAPICallRefused)
	status, _, _ = read(ownerSession, owner.ID, "/api/todos/1/merge")
	require.Equal(t, http.StatusNotFound, status)
	status, _, _ = read(ownerSession, owner.ID, "/api/user/tokens")
	require.Equal(t, http.StatusNotFound, status)
}
