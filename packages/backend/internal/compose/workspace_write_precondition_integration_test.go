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
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/process"
	"github.com/stretchr/testify/require"
)

// Production single-owner composer and real PostgreSQL. This is HTTP contract
// and unavailable-provider evidence, not the real-machine C-COL-01 receipt.
func TestWorkspaceWritePreconditionsInstall(t *testing.T) {
	_, _, pool := splitProcessDatabase(t)
	ctx := t.Context()
	q := db.New(pool)
	owner, err := q.CreateUser(ctx, db.CreateUserParams{Username: "digestowner", LowerUsername: "digestowner"})
	require.NoError(t, err)
	_, err = pool.Exec(ctx, `INSERT INTO self_host_owners(user_id) VALUES($1)`, owner.ID)
	require.NoError(t, err)
	repo, err := q.CreateRepo(ctx, db.CreateRepoParams{UserID: pgtype.Int8{Int64: owner.ID, Valid: true}, Name: "demo", LowerName: "demo", DefaultBookmark: "main"})
	require.NoError(t, err)
	binding := fmt.Sprintf(`{"owner_login":"digestowner","repository_name":"demo","repository_id":%d,"last_access_check_at":"%s"}`, repo.ID, time.Now().UTC().Format(time.RFC3339))
	for key, value := range map[string]string{"setup.step.source": `{"id":"source","status":"done"}`, "setup.source.repository": `"digestowner/demo"`, "github.repository": binding, "owner.access": binding} {
		require.NoError(t, q.UpsertInstallSetting(ctx, db.UpsertInstallSettingParams{Key: key, Value: []byte(value)}))
	}
	const cookie = "digest-cookie"
	hash := sha256.Sum256([]byte(cookie))
	_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: owner.ID, Username: owner.Username, SessionKey: hex.EncodeToString(hash[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	var id string
	require.NoError(t, pool.QueryRow(ctx, `INSERT INTO workspaces(repository_id,user_id,name,kind,status,vm_id,target_bookmark) VALUES($1,$2,'digest','container','running','fixture','smithers/digest') RETURNING id`, repo.ID, owner.ID).Scan(&id))
	runtime, err := process.New(process.Config{Root: t.TempDir()})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, runtime.Close()) })
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	t.Setenv("SMITHERS_PUBLIC_URL", origin)
	install := startSplitProcess(t, Options{FlowHostProductAPIURL: origin, Workspace: runtime, ChatHost: unusedChatHost{}})
	var decisionMu sync.Mutex
	var decisions []string
	server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := services.WithAuthorizationObserver(r.Context(), func(command string) {
			decisionMu.Lock()
			defer decisionMu.Unlock()
			decisions = append(decisions, command)
		})
		install.ServeHTTP(w, r.WithContext(ctx))
	})
	server.Start()
	defer server.Close()
	for _, item := range []struct {
		body   string
		status int
	}{
		{`{"content":"new"}`, 400},
		{`{"content":"new","base_digest":"bad"}`, 400},
		{`{"content":"new","base_digest":null}`, 400},
		{`{"content":"new","base_digest":"absent","actor":"owner"}`, 400},
		{`{"content":"new","base_digest":"absent","branch":"main"}`, 400},
		{`{"content":"new","base_digest":"absent","machine":"fixture"}`, 400},
		{`{"content":"new","base_digest":"absent","uid":0}`, 400},
		{`{"content":"new","base_digest":"absent"}`, 503},
		{`{"changes":[{"path":"a","content":"new","base_digest":"absent"},{"path":"b","content":null,"base_digest":"absent"}]}`, 503},
		{`{"changes":[{"path":"a","content":"new","base_digest":"absent","uid":0}]}`, 400},
		{`{"changes":[{"path":"a","content":"new","base_digest":"absent"},{"path":"a/b","content":null,"base_digest":"absent"}]}`, 400},
		{`{"changes":[{"path":"a","content":"new"}]}`, 400},
	} {
		query := "?path=a.ts"
		if strings.Contains(item.body, `"changes"`) {
			query = ""
		}
		req, err := http.NewRequest("PUT", server.URL+"/api/repos/digestowner/demo/workspaces/"+id+"/files/content"+query, strings.NewReader(item.body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		req.Header.Set("X-CSRF-Token", "digest-csrf")
		req.AddCookie(&http.Cookie{Name: "__csrf", Value: "digest-csrf"})
		req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
		response, err := server.Client().Do(req)
		require.NoError(t, err)
		body, err := io.ReadAll(response.Body)
		require.NoError(t, err)
		require.NoError(t, response.Body.Close())
		require.Equal(t, item.status, response.StatusCode, string(body))
	}
	// No mutation request provisioned a process or machine as a fallback.
	require.Empty(t, runtime.WorkspaceIDs())

	// Exercise real private issuance, normal token authentication and the
	// production workspace handler together. No qualified guest is present,
	// so a valid grant reaches the provider gate and still cannot write.
	codec, err := newSecretCodec(config.WebhookConfig{SecretEncryptionKey: "file-grant-fixture"})
	require.NoError(t, err)
	hosts, err := flowhost.NewStore(pool, codec)
	require.NoError(t, err)
	lease, err := hosts.Acquire(ctx, flowhost.Authority{
		Target:       flowruntime.Target{TenantID: fmt.Sprintf("repository:%d", repo.ID), PrincipalID: fmt.Sprintf("user:%d", owner.ID), BindingKind: "browser-flow", BindingID: "digestowner/demo"},
		RepositoryID: repo.ID, UserID: owner.ID, WorkspaceID: id, CatalogKey: flowhost.CatalogCoding, SourceRevision: strings.Repeat("a", 40),
	}, flowhost.Catalog{Key: flowhost.CatalogCoding, Family: flowhost.CatalogCoding, Executable: "/opt/smithers/coding", ArtifactDigest: strings.Repeat("b", 64), ServiceName: "coding", SystemFlows: []string{"coding/plan"}})
	require.NoError(t, err)
	_, err = lease.PrepareStart(ctx, false)
	require.NoError(t, err)
	require.NoError(t, lease.MarkRunning(ctx, "file-grant-test"))
	hostID, credential := lease.Binding().ID, lease.Credential()
	require.NoError(t, lease.Close())
	call := func(method, path, bearer, body string) (int, []byte) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, strings.NewReader(body))
		require.NoError(t, err)
		req.Header.Set("Content-Type", "application/json")
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		res, err := server.Client().Do(req)
		require.NoError(t, err)
		data, err := io.ReadAll(res.Body)
		require.NoError(t, err)
		require.NoError(t, res.Body.Close())
		return res.StatusCode, data
	}
	const batch = `{"changes":[{"path":"a.txt","base_digest":"absent","content":"new"}]}`
	digest := sha256.Sum256([]byte(batch))
	runID := strings.Repeat("a", 64) + "/coding/" + strings.Repeat("b", 64) + "/coding/edit-atom@" + strings.Repeat("c", 64) + ":1#0"
	subject := fmt.Sprintf(`{"run_id":%q,"batch_digest":"%x"}`, runID, digest)
	issuerPath := "/api/gateways/" + hostID + "/file-write-grants"
	for _, bearer := range []string{"", "invalid"} {
		status, data := call("POST", issuerPath, bearer, subject)
		require.Equal(t, 401, status, string(data))
	}
	status, data := call("POST", issuerPath, credential, `{"run_id":"Run-A","batch_digest":"bad","extra":true}`)
	require.Equal(t, 400, status, string(data))
	status, data = call("POST", issuerPath, credential, subject)
	require.Equal(t, 201, status, string(data))
	var grant services.CodingFileGrant
	require.NoError(t, json.Unmarshal(data, &grant))
	require.Equal(t, runID, grant.RunID)
	writePath := "/api/repos/digestowner/demo/workspaces/" + id + "/files/content"
	for _, attempt := range []struct {
		method, path, body string
		want               int
	}{
		{"PUT", writePath, batch, 503},
		{"PUT", writePath, batch + " ", 403},
		{"PUT", writePath + "?path=a.txt", batch, 403},
		{"GET", "/api/user", "", 403},
		{"POST", issuerPath, subject, 401},
	} {
		decisionMu.Lock()
		decisions = nil
		decisionMu.Unlock()
		status, data = call(attempt.method, attempt.path, grant.Token, attempt.body)
		decisionMu.Lock()
		observed := append([]string(nil), decisions...)
		decisionMu.Unlock()
		if attempt.want == 503 {
			require.Equal(t, []string{"branch.join"}, observed, "exact batch obtains one decision before provider admission")
		} else {
			require.Empty(t, observed, "credential/body refusals precede command admission")
		}
		require.Equal(t, attempt.want, status, string(data))
		require.NotContains(t, string(data), grant.Token)
	}
	for range 2 {
		status, data = call("DELETE", fmt.Sprintf("%s/%d", issuerPath, grant.TokenID), grant.Token, "")
		require.Equal(t, 204, status, string(data))
	}
	status, data = call("PUT", writePath, grant.Token, batch)
	require.Equal(t, 401, status, string(data))
	require.Empty(t, runtime.WorkspaceIDs())
}
