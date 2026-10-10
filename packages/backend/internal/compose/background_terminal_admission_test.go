package compose

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	gliderssh "github.com/gliderlabs/ssh"
	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/admission"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	transport "github.com/smithersai/smithers/packages/backend/internal/ssh"
	"github.com/smithersai/smithers/packages/backend/repository"
	productssh "github.com/smithersai/smithers/packages/backend/ssh"
	"github.com/stretchr/testify/require"
	gossh "golang.org/x/crypto/ssh"
)

type backgroundAdmissionBridge struct{ calls atomic.Int32 }

func (b *backgroundAdmissionBridge) Validate(context.Context, productssh.WorkspaceAccess) error {
	b.calls.Add(1)
	return productssh.ErrWorkspaceAccessDenied
}
func (b *backgroundAdmissionBridge) Serve(gliderssh.Session, productssh.WorkspaceAccess) (int, error) {
	b.calls.Add(1)
	return 1, productssh.ErrWorkspaceAccessDenied
}

// HTTP is the app Terminal card's door. The guest port must never be reached;
// membership, workspace classification and request persistence use real SQL.
func TestBackgroundMachineTerminalAdmission(t *testing.T) {
	for _, kind := range []string{"workflow", "learning", "review", "wiki", "retired-host"} {
		t.Run(kind, func(t *testing.T) { testBackgroundMachineTerminalAdmission(t, kind) })
	}
}

func testBackgroundMachineTerminalAdmission(t *testing.T, kind string) {
	f := presenceInstall(t)
	q, ctx := db.New(f.pool), t.Context()
	owner, err := q.GetBranchMachineOwner(ctx)
	require.NoError(t, err)
	branch, err := q.CreateWorkspace(ctx, db.CreateWorkspaceParams{RepositoryID: f.row.RepositoryID, UserID: owner, Name: "background", TargetBookmark: "scratch/presence-owner/background", Status: "running", Kind: "vm"})
	require.NoError(t, err)

	switch kind {
	case "workflow":
		var definition, run int64
		require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO workflow_definitions(repository_id,name,path,config) VALUES ($1,'manual','.smithers/manual.ts','{}') RETURNING id`, branch.RepositoryID).Scan(&definition))
		require.NoError(t, f.pool.QueryRow(ctx, `INSERT INTO workflow_runs(repository_id,workflow_definition_id,status,trigger_event,trigger_ref) VALUES ($1,$2,'running','manual','main') RETURNING id`, branch.RepositoryID, definition).Scan(&run))
		_, err = f.pool.Exec(ctx, `INSERT INTO workflow_run_flow_invocations(workflow_run_id,user_id,flow_id,operation_id,background_workspace_id) VALUES ($1,$2,'main','background-op',$3::uuid)`, run, f.user.ID, branch.ID)
	case "wiki":
		_, err = f.pool.Exec(ctx, `INSERT INTO mythical_wikis(repository_id,workspace_id) VALUES($1,$2) ON CONFLICT(repository_id) DO UPDATE SET workspace_id=$2`, branch.RepositoryID, branch.ID)
	case "learning", "review":
		operation := uuid.NewString()
		name, op, payload := "review-"+operation, "install.review", "{}"
		if kind == "learning" {
			name, op, payload = "learning-"+operation, "learning.admission", fmt.Sprintf(`{"item":%q}`, operation)
		}
		_, err = f.pool.Exec(ctx, `UPDATE workspaces SET name=$2 WHERE id=$1`, branch.ID, name)
		require.NoError(t, err)
		_, err = f.pool.Exec(ctx, `INSERT INTO product_job_requests(id,tenant_id,principal_id,operation,request_id,payload_fingerprint,payload,authorization_context,state,request_receipt) VALUES($1::uuid,$2,$3,$4,$1::text,decode(repeat('00',32),'hex'),$5,'{}','accepted','{}')`, operation, fmt.Sprint(branch.RepositoryID), fmt.Sprint(f.user.ID), op, payload)
	case "retired-host":
		_, err = f.pool.Exec(ctx, `INSERT INTO flow_runtime_host_bindings(id,tenant_id,principal_id,binding_kind,binding_id,repository_id,user_id,workspace_id,catalog_key,service_name,runtime_artifact_digest,source_revision,owner_generation,credential_ciphertext,credential_hash,state) VALUES($1,'test','test','learning','test',$2,$3,$4,'coding','test',$5,$6,1,'test',decode(repeat('00',32),'hex'),'retired')`, uuid.NewString(), branch.RepositoryID, f.user.ID, branch.ID, strings.Repeat("b", 64), strings.Repeat("a", 40))
	}
	require.NoError(t, err)
	runtime := &requestHTTPRuntime{entered: make(chan struct{}), release: make(chan struct{})}
	service := services.NewWorkspaceService(q, services.WithWorkspaceRuntime(runtime), services.WithWorkspaceTransactions(f.pool), services.WithBranchMachineProviders(*rehearsalBranchMachines(f.pool)))
	service.BindBranchTerminalHost(func(context.Context, db.Workspace, int64) error { panic("background machine reached guest") })
	service.BindOwnerTerminalOpen(func(context.Context, string, string, int64, int64) error {
		return fmt.Errorf("background machine reached guest")
	})
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Server.PublicURL = "http://localhost:4000"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	cfg.RateLimit.TerminalOpenPerMin = 100
	router := hostStatusProductionRouter(cfg, q, &services.InstallCapacityService{Queries: q}, conformanceServices{pool: f.pool, workspace: &routes.WorkspaceHandler{Service: service}, terminal: &routes.WorkspaceTerminalHandler{Service: service, AllowedOrigins: cfg.Server.AllowedOrigins}})

	// Real SSH handshake, production branch resolver and per-channel boundary.
	// Only the unavailable guest transport is replaced; it must see no calls.
	policy, err := admission.NewMetered(f.pool, admission.Config{Usage: admission.ProductUsage})
	require.NoError(t, err)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := listener.Addr().String()
	require.NoError(t, listener.Close())
	bridge := &backgroundAdmissionBridge{}
	sshServer, err := productssh.New(ctx, productssh.Config{Database: f.pool, Repository: repository.NewRemoteClient(nil, "test"), Admission: policy, Addr: addr, HostKeyDir: t.TempDir(), LFSSigningSecret: "test", PublicAPIOrigin: cfg.Server.PublicURL, BranchLogins: true, WorkspaceBridge: bridge})
	require.NoError(t, err)
	serving := make(chan error, 1)
	go func() { serving <- sshServer.ListenAndServe() }()
	defer func() {
		stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		require.NoError(t, sshServer.Shutdown(stop))
		<-serving
	}()
	require.Eventually(t, func() bool {
		connection, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			return false
		}
		_ = connection.Close()
		return true
	}, 5*time.Second, 20*time.Millisecond)
	member, err := q.CreateUser(ctx, db.CreateUserParams{Username: "background-member", LowerUsername: "background-member"})
	require.NoError(t, err)
	for i, person := range []db.User{f.user, member} {
		_, err = f.pool.Exec(ctx, `INSERT INTO collaborators(repository_id,user_id,permission,unix_login,unix_uid) VALUES($1,$2,'write',$3,$4)`, branch.RepositoryID, person.ID, fmt.Sprintf("person%d", i), 20041+i)
		require.NoError(t, err)
		cookie := fmt.Sprintf("background-person-%d", i)
		sum := sha256.Sum256([]byte(cookie))
		_, err = q.CreateAuthSession(ctx, db.CreateAuthSessionParams{UserID: person.ID, Username: person.Username, SessionKey: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)})
		require.NoError(t, err)
		for _, ref := range []string{branch.ID, branch.TargetBookmark} {
			t.Run(fmt.Sprintf("person%d/%s", i, ref), func(t *testing.T) {
				req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/terminals", strings.NewReader(fmt.Sprintf(`{"branch":%q}`, ref)))
				req.RemoteAddr = "127.0.0.1:1234"
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("X-CSRF-Token", "csrf")
				req.Header.Set("Idempotency-Key", uuid.NewString())
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, http.StatusForbidden, out.Code, out.Body.String())
				require.JSONEq(t, `{"class":"permission","code":"permission","message":"Access denied"}`, out.Body.String())
			})
		}

		_, private, err := ed25519.GenerateKey(rand.Reader)
		require.NoError(t, err)
		signer, err := gossh.NewSignerFromKey(private)
		require.NoError(t, err)
		_, err = q.CreateSSHKey(ctx, db.CreateSSHKeyParams{UserID: person.ID, Name: "background-test", PublicKey: string(gossh.MarshalAuthorizedKey(signer.PublicKey())), Fingerprint: gossh.FingerprintSHA256(signer.PublicKey()), KeyType: "ssh-ed25519"})
		require.NoError(t, err)
		t.Run(fmt.Sprintf("person%d/SSH handshake", i), func(t *testing.T) {
			connection, err := gossh.Dial("tcp", addr, &gossh.ClientConfig{User: branch.TargetBookmark, Auth: []gossh.AuthMethod{gossh.PublicKeys(signer)}, HostKeyCallback: gossh.InsecureIgnoreHostKey(), Timeout: time.Second})
			if connection != nil {
				_ = connection.Close()
			}
			require.Error(t, err)
			require.Zero(t, bridge.calls.Load(), "background refusal must precede guest admission")
		})
		t.Run(fmt.Sprintf("person%d/SSH", i), func(t *testing.T) {
			_, err := (&transport.InstallBranchResolver{Database: f.pool}).ResolveBranch(ctx, person.ID, "scratch/presence-owner/background")
			require.Error(t, err, "SSH must refuse before connecting a guest")
		})

		t.Run(fmt.Sprintf("person%d/shared admission", i), func(t *testing.T) {
			for _, ref := range []string{branch.ID, branch.TargetBookmark} {
				_, err := service.AuthorizeTerminalBranch(ctx, ref, branch.RepositoryID, person.ID)
				require.ErrorContains(t, err, "background machine belongs to its run")
				_, err = service.OpenSSHReservation(ctx, ref, branch.RepositoryID, person.ID, uuid.NewString())
				require.ErrorContains(t, err, "background machine belongs to its run")
			}
		})
		stale, err := q.CreateWorkspaceSession(ctx, db.CreateWorkspaceSessionParams{WorkspaceID: branch.ID, RepositoryID: branch.RepositoryID, UserID: person.ID, Cols: 80, Rows: 24})
		require.NoError(t, err)
		for _, door := range []struct{ method, path, body string }{
			{"POST", "/api/repos/presence-owner/app/workspace/sessions", fmt.Sprintf(`{"workspace_id":%q}`, branch.ID)},
			{"GET", "/api/repos/presence-owner/app/workspace/sessions/" + stale.ID + "/terminal", ""},
		} {
			t.Run(fmt.Sprintf("person%d/%s", i, door.path), func(t *testing.T) {
				req := httptest.NewRequest(door.method, cfg.Server.PublicURL+door.path, strings.NewReader(door.body))
				req.RemoteAddr = "127.0.0.1:1234"
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Origin", cfg.Server.PublicURL)
				req.Header.Set("X-CSRF-Token", "csrf")
				req.AddCookie(&http.Cookie{Name: "__csrf", Value: "csrf"})
				req.AddCookie(&http.Cookie{Name: "smithers_session", Value: cookie})
				out := httptest.NewRecorder()
				router.ServeHTTP(out, req)
				require.Equal(t, http.StatusForbidden, out.Code, out.Body.String())
			})
		}
		_, err = f.pool.Exec(ctx, `DELETE FROM workspace_sessions WHERE id=$1`, stale.ID)
		require.NoError(t, err)
		t.Run(fmt.Sprintf("person%d/session", i), func(t *testing.T) {
			_, err := service.CreateSession(ctx, services.CreateWorkspaceSessionInput{WorkspaceID: branch.ID, RepositoryID: branch.RepositoryID, UserID: person.ID})
			require.ErrorContains(t, err, "background machine belongs to its run")
		})
	}
	require.NoError(t, service.WaitForProvisioning(ctx))
	var events, sessions, tokens int
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events WHERE event_type='terminal.requested'`).Scan(&events))
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM workspace_sessions WHERE workspace_id=$1`, branch.ID).Scan(&sessions))
	require.NoError(t, f.pool.QueryRow(ctx, `SELECT count(*) FROM access_tokens`).Scan(&tokens))
	require.Zero(t, events)
	require.Zero(t, sessions)
	require.Zero(t, tokens)
}
