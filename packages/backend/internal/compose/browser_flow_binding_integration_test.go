package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

// The relay, sessions, membership and stored workspace are real. Only the
// external guest transport is recorded; no refused request may reach it.
func TestBrowserFlowStoredBindingComposedInstall(t *testing.T) {
	f := newLandingGateFixtureWithFactory(t, nil, "", true)
	cfg := testConfigAllFlagsOn()
	cfg.Auth.Mode = "selfhost"
	cfg.Auth.SessionCookieName = "session"
	cfg.Server.PublicURL = "http://example.com"
	cfg.Server.AllowedOrigins = []string{cfg.Server.PublicURL}
	workspace, err := f.q.CreateWorkspace(f.ctx, db.CreateWorkspaceParams{RepositoryID: f.repoID, UserID: f.other.ID, Name: "bound-relay", TargetBookmark: "scratch/member/bound", Kind: "container", Status: "running"})
	require.NoError(t, err)
	cookie := "bound-relay-session"
	digest := sha256.Sum256([]byte(cookie))
	_, err = f.q.CreateAuthSession(f.ctx, db.CreateAuthSessionParams{UserID: f.other.ID, Username: f.other.Username, SessionKey: hex.EncodeToString(digest[:]), ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)
	repo, err := f.q.GetRepoByID(f.ctx, f.repoID)
	require.NoError(t, err)
	request := browserFlowRequest{Repo: f.owner.Username + "/" + repo.Name, WorkspaceID: workspace.ID, Procedure: "Plan", Payload: json.RawMessage(`{"flowId":"greeting","input":{}}`)}
	raw, err := json.Marshal(request)
	require.NoError(t, err)
	for _, change := range []string{"unchanged", "bookmark", "generation", "machine", "status", "owner", "credential", "trailing JSON", "unknown field", "classifier payload"} {
		t.Run(change, func(t *testing.T) {
			_, err := f.pool.Exec(f.ctx, `UPDATE workspaces SET target_bookmark=$2,vm_id=$3,provisioning_generation=$4,status='running',user_id=$5 WHERE id=$1`, workspace.ID, workspace.TargetBookmark, workspace.VmID, workspace.ProvisioningGeneration, f.other.ID)
			require.NoError(t, err)
			recorder := &browserBindingDispatcher{mutate: change == "classifier payload"}
			api := &browserFlowAPI{repos: services.NewRepoService(f.q, nil, ""), queries: f.q, dispatcher: recorder}
			api.limit = func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					switch change {
					case "bookmark":
						_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET target_bookmark='scratch/member/replaced' WHERE id=$1`, workspace.ID)
					case "generation":
						_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET provisioning_generation=provisioning_generation+1 WHERE id=$1`, workspace.ID)
					case "machine":
						_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET vm_id='replaced' WHERE id=$1`, workspace.ID)
					case "status":
						_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET status='stopped' WHERE id=$1`, workspace.ID)
					case "owner":
						_, err = f.pool.Exec(f.ctx, `UPDATE workspaces SET user_id=$2 WHERE id=$1`, workspace.ID, f.owner.ID)
					case "credential":
						clone := *middleware.AuthInfoFromContext(r.Context())
						r = r.WithContext(middleware.ContextWithAuthInfo(r.Context(), &clone))
					}
					require.NoError(t, err)
					next.ServeHTTP(w, r)
				})
			}
			router := chi.NewRouter()
			mountBrowserFlow(router, cfg, f.q, api)
			body := string(raw)
			if change == "trailing JSON" {
				body += " {}"
			}
			if change == "unknown field" {
				body = strings.TrimSuffix(body, "}") + `,"command":"install.settings"}`
			}
			req := httptest.NewRequest(http.MethodPost, cfg.Server.PublicURL+"/api/workflow/rpc", strings.NewReader(body))
			req.AddCookie(&http.Cookie{Name: "session", Value: cookie})
			req.AddCookie(&http.Cookie{Name: middleware.CSRFCookieName, Value: "csrf"})
			req.Header.Set("Origin", cfg.Server.PublicURL)
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-CSRF-Token", "csrf")
			var commands []string
			req = req.WithContext(services.WithAuthorizationObserver(req.Context(), func(command string) { commands = append(commands, command) }))
			out := httptest.NewRecorder()
			router.ServeHTTP(out, req)
			switch change {
			case "unchanged", "classifier payload":
				require.Equal(t, 200, out.Code, out.Body.String())
				require.Len(t, recorder.calls, 1)
				require.JSONEq(t, string(request.Payload), string(recorder.calls[0].payload))
			case "trailing JSON", "unknown field":
				require.Equal(t, 400, out.Code, out.Body.String())
				require.Empty(t, commands)
				require.Empty(t, recorder.calls)
			default:
				require.Equal(t, 403, out.Code, out.Body.String())
				require.Contains(t, out.Body.String(), `"code":"permission"`)
				require.Empty(t, recorder.calls)
			}
			if change != "trailing JSON" && change != "unknown field" {
				require.Equal(t, []string{"flow.plan"}, commands, fmt.Sprint(commands))
			}
		})
	}
}

type browserBindingDispatcher struct {
	browserFlowRecordingDispatcher
	mutate bool
}

func (d *browserBindingDispatcher) RefuseRelay(ctx context.Context, target flowruntime.Target, procedure string, payload json.RawMessage) error {
	if err := d.browserFlowRecordingDispatcher.RefuseRelay(ctx, target, procedure, payload); err != nil {
		return err
	}
	if d.mutate {
		copy(payload, strings.ReplaceAll(string(payload), "greeting", "replaced"))
	}
	return nil
}
