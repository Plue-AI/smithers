package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/credits"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
	"github.com/stretchr/testify/require"
)

func TestAdminGrantProductHTTPPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	user := func(name string, admin bool) db.User {
		u, e := q.CreateUser(ctx, db.CreateUserParams{Username: name, LowerUsername: name})
		require.NoError(t, e)
		if admin {
			require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: u.ID, IsAdmin: true}))
			u, e = q.GetUserByID(ctx, u.ID)
			require.NoError(t, e)
		}
		return u
	}
	admin, ordinary, recipient := user("http-grant-admin", true), user("http-grant-user", false), user("http-grant-recipient", false)
	token := func(u db.User, scope string) string {
		raw := fmt.Sprintf("smithers_%040x", u.ID*100+int64(len(scope)))
		sum := sha256.Sum256([]byte(raw))
		hash := hex.EncodeToString(sum[:])
		_, e := q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: u.ID, Name: scope, TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: scope, ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
		require.NoError(t, e)
		return raw
	}
	writeAdmin, readAdmin, nonAdmin := token(admin, "write:admin"), token(admin, "read:admin"), token(ordinary, "write:admin")
	fn := reflect.ValueOf(buildRouter)
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args[:len(args)-1] {
		args[i] = reflect.Zero(fn.Type().In(i))
	}
	args[0] = reflect.ValueOf(testConfigAllFlagsOn())
	args[1] = reflect.ValueOf(q)
	args[2] = reflect.ValueOf(pool)
	args[len(args)-1] = reflect.ValueOf([]any{routerExtras{AdminGrant: &routes.AdminGrantHandler{Service: services.NewAdminGrantService(pool, credits.Ledger{DB: pool})}}})
	server := httptest.NewServer(fn.CallSlice(args)[0].Interface().(http.Handler))
	defer server.Close()
	post := func(auth, body string) (int, []byte) {
		r, e := http.NewRequest("POST", server.URL+"/api/admin/grant", strings.NewReader(body))
		require.NoError(t, e)
		r.Header.Set("content-type", "application/json")
		if auth != "" {
			r.Header.Set("Authorization", "Bearer "+auth)
		}
		res, e := http.DefaultClient.Do(r)
		require.NoError(t, e)
		defer res.Body.Close()
		raw, e := io.ReadAll(res.Body)
		require.NoError(t, e)
		return res.StatusCode, raw
	}
	body := `{"login":" HTTP-GRANT-RECIPIENT ","amountUsd":25,"operationKey":"http-grant-once"}`
	for _, tc := range []struct {
		token  string
		status int
	}{{"", 401}, {"smithers_0000000000000000000000000000000000000000", 401}, {nonAdmin, 403}, {readAdmin, 403}} {
		status, raw := post(tc.token, body)
		require.Equal(t, tc.status, status, string(raw))
	}
	status, raw := post(writeAdmin, body)
	require.Equal(t, 200, status, string(raw))
	var result services.AdminGrantResult
	require.NoError(t, json.Unmarshal(raw, &result))
	require.True(t, result.Granted)
	require.False(t, result.Duplicate)
	require.Equal(t, recipient.Username, result.Login)
	status, raw = post(writeAdmin, body)
	require.Equal(t, 200, status, string(raw))
	var duplicate services.AdminGrantResult
	require.NoError(t, json.Unmarshal(raw, &duplicate))
	require.True(t, duplicate.Duplicate)
	require.Equal(t, result.GrantID, duplicate.GrantID)
	status, raw = post(writeAdmin, strings.Replace(body, "25", "26", 1))
	require.Equal(t, 409, status, string(raw))
	status, raw = post(writeAdmin, `{"login":"http-grant-recipient","amountUsd":25,"operationKey":"bad","isAdmin":true}`)
	require.Equal(t, 400, status, string(raw))
	balance, e := (credits.Ledger{DB: pool}).OwnerBalance(ctx, "user", recipient.ID)
	require.NoError(t, e)
	require.Equal(t, int64(25_000_000_000), balance)
	var count int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE event_type='admin.credit.grant'`).Scan(&count))
	require.Equal(t, 1, count)
	// Revoke the actual role; the same still-valid PAT cannot write another grant.
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: admin.ID, IsAdmin: false}))
	status, raw = post(writeAdmin, strings.Replace(body, "http-grant-once", "after-revoke", 1))
	require.Equal(t, 403, status, string(raw))
}

// A real Bun app controller uses the mounted product HTTP router and real PG.
// The fixture only delays a response; authentication and grant execution stay real.
func TestAdminGrantAppHTTPPostgres(t *testing.T) {
	pool, _ := postgresfixture.NewProductDatabase(t)
	ctx := context.Background()
	q := db.New(pool)
	admin, e := q.CreateUser(ctx, db.CreateUserParams{Username: "app-grant-admin", LowerUsername: "app-grant-admin"})
	require.NoError(t, e)
	require.NoError(t, q.SetUserAdmin(ctx, db.SetUserAdminParams{UserID: admin.ID, IsAdmin: true}))
	recipient, e := q.CreateUser(ctx, db.CreateUserParams{Username: "app-grant-recipient", LowerUsername: "app-grant-recipient"})
	require.NoError(t, e)
	rawToken := "smithers_1234567890123456789012345678901234567890"
	sum := sha256.Sum256([]byte(rawToken))
	hash := hex.EncodeToString(sum[:])
	_, e = q.CreateAccessToken(ctx, db.CreateAccessTokenParams{UserID: admin.ID, Name: "app-grant", TokenHash: hash, TokenLastEight: hash[len(hash)-8:], Scopes: "write:admin,read:user", ExpiresAt: pgtype.Timestamptz{Time: time.Now().Add(time.Hour), Valid: true}})
	require.NoError(t, e)
	fn := reflect.ValueOf(buildRouter)
	args := make([]reflect.Value, fn.Type().NumIn())
	for i := range args[:len(args)-1] {
		args[i] = reflect.Zero(fn.Type().In(i))
	}
	args[0] = reflect.ValueOf(testConfigAllFlagsOn())
	args[1] = reflect.ValueOf(q)
	args[2] = reflect.ValueOf(pool)
	for i := range args {
		if fn.Type().In(i) == reflect.TypeOf((*routes.UserHandler)(nil)) {
			args[i] = reflect.ValueOf(&routes.UserHandler{ProfileService: services.NewUserService(q)})
		}
	}
	args[len(args)-1] = reflect.ValueOf([]any{routerExtras{AdminGrant: &routes.AdminGrantHandler{Service: services.NewAdminGrantService(pool, credits.Ledger{DB: pool})}}})
	router := fn.CallSlice(args)[0].Interface().(http.Handler)
	release, committed := make(chan struct{}), make(chan struct{})
	var once sync.Once
	var posted atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/__grant_state" {
			var n int
			e := pool.QueryRow(r.Context(), `SELECT count(*) FROM credit_grants WHERE starts_with(source_key,'admin:grant-')`).Scan(&n)
			if e != nil {
				http.Error(w, e.Error(), 500)
				return
			}
			json.NewEncoder(w).Encode(map[string]int{"posted": int(posted.Load()), "grants": n})
			return
		}
		if r.URL.Path == "/__grant_release" {
			once.Do(func() { close(release) })
			select {
			case <-committed:
				w.WriteHeader(204)
			case <-r.Context().Done():
			}
			return
		}
		if r.URL.Path == "/api/admin/grant" && posted.Add(1) == 1 {
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, r)
			if rec.Code != 200 {
				w.WriteHeader(rec.Code)
				w.Write(rec.Body.Bytes())
				close(committed)
				return
			}
			close(committed)
			// This page never receives the committed receipt; reload must reuse its key.
			<-r.Context().Done()
			return
		}
		router.ServeHTTP(w, r)
	}))
	defer server.Close()
	defer once.Do(func() { close(release) })
	bun, e := exec.LookPath("bun")
	require.NoError(t, e, "Bun is required for this actual app consumer, not an optional skip")
	root, e := filepath.Abs("../../../..")
	require.NoError(t, e)
	commandCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(commandCtx, bun, "apps/app/scripts/admin-grant-backend-consumer.ts")
	command.Dir = root
	command.Env = append(os.Environ(), "SMITHERS_ADMIN_GRANT_TEST_ORIGIN="+server.URL, "SMITHERS_ADMIN_GRANT_TEST_TOKEN="+rawToken)
	output, e := command.CombinedOutput()
	require.NoError(t, e, string(output))
	t.Log(string(output))
	require.Equal(t, int32(2), posted.Load(), "One original and one same-key reload request")
	balance, e := (credits.Ledger{DB: pool}).OwnerBalance(ctx, "user", recipient.ID)
	require.NoError(t, e)
	require.Equal(t, int64(25_000_000_000), balance)
	var n int
	require.NoError(t, pool.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE event_type='admin.credit.grant'`).Scan(&n))
	require.Equal(t, 1, n)
}
