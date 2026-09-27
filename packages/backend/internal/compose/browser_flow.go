package compose

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/background"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

var browserFlowRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// The procedure set is the product relay contract in apps/server/gatewayRpc.ts.
// All payload and result bodies remain canonical Control/Gateway RPC shapes.
var browserFlowProcedures = map[string]bool{
	"Plan": true, "Run": true, "Cancel": true, "Resume": true,
	"Steer": true, "Signal": true, "List": true,
	"Projection.Snapshot": true, "Approval.Submit": true,
}

type browserFlowAPI struct {
	repos interface {
		GetRepoView(context.Context, *db.User, string, string) (services.RepoView, error)
	}
	queries interface {
		GetWorkspaceForUserRepo(context.Context, db.GetWorkspaceForUserRepoParams) (db.Workspace, error)
	}
	dispatcher browserFlowDispatcher
	// boxes resumes a sleeping box (services.WorkspaceService).
	boxes interface {
		ResumeWorkspace(context.Context, string, int64, int64) (services.WorkspaceResponse, error)
	}
	// resumes are the background resumes of sleeping boxes, by box.
	resumes background.Jobs[string]
	// limit is the account-wide API budget. Reads a run's progress polls
	// (Projection.Snapshot, List) stay out of it, as the box relay always did.
	limit func(http.Handler) http.Handler
	// subscriptionTokens mirrors feature_flags.subscription_connections.
	subscriptionTokens bool
}

// browserFlowDispatcher is the box's flow seam (flowdispatch.Service).
type browserFlowDispatcher interface {
	CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error)
	StartHost(context.Context, flowruntime.Target) (bool, error)
}

var _ browserFlowDispatcher = (*flowdispatch.Service)(nil)

type browserFlowRequest struct {
	Repo        string          `json:"repo"`
	WorkspaceID string          `json:"workspaceId"`
	Procedure   string          `json:"procedure"`
	Payload     json.RawMessage `json:"payload"`
}

func browserFlowJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

// browserFlowRebuildRequired refuses a workspace built while its repository
// stored a subscription token (#2206).
const browserFlowRebuildRequired = "This workspace was built with a Claude or ChatGPT subscription token. Delete it and create a new workspace."

func browserFlowRefusal(w http.ResponseWriter, status int, message string) {
	browserFlowJSON(w, status, map[string]any{"ok": false, "error": map[string]string{"message": message}})
}

// browserFlowTyped is a refusal a client acts on by its code, which the
// Worker's platform proxy keeps only at the top level.
func browserFlowTyped(w http.ResponseWriter, status int, code, message string) {
	browserFlowJSON(w, status, map[string]any{"ok": false, "code": code, "error": map[string]string{"code": code, "message": message}})
}

// browserFlowProvisioning is the answer the app polls while a box wakes or
// its coding host starts.
func browserFlowProvisioning(w http.ResponseWriter) {
	browserFlowJSON(w, http.StatusOK, map[string]any{"status": "provisioning"})
}

func (api *browserFlowAPI) prepare(w http.ResponseWriter, r *http.Request, provision bool) (browserFlowRequest, flowruntime.Target, db.Workspace, bool) {
	var request browserFlowRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	// Every flow runs on a box: its coding host serves the catalog. There is
	// no repository-level host to fall back to (#2194).
	if decoder.Decode(&request) != nil || !browserFlowRepo.MatchString(request.Repo) || !validBrowserWorkspaceID(request.WorkspaceID) {
		browserFlowRefusal(w, http.StatusBadRequest, "Body must name a repository and a box (workspaceId).")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	if !provision && !browserFlowProcedures[request.Procedure] {
		browserFlowRefusal(w, http.StatusBadRequest, "The workflow seam does not relay this procedure.")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		browserFlowRefusal(w, http.StatusUnauthorized, "Sign in to run flows.")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	owner, name, _ := strings.Cut(request.Repo, "/")
	view, err := api.repos.GetRepoView(r.Context(), user, owner, name)
	if err != nil || !view.CanWrite {
		browserFlowRefusal(w, http.StatusNotFound, "Repository unavailable.")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	workspace, err := api.queries.GetWorkspaceForUserRepo(r.Context(), db.GetWorkspaceForUserRepoParams{
		ID: request.WorkspaceID, RepositoryID: view.Repository.ID, UserID: user.ID,
	})
	if err == nil && workspace.RebuildRequiredAt.Valid && !api.subscriptionTokens {
		browserFlowRefusal(w, http.StatusConflict, browserFlowRebuildRequired)
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	if err != nil {
		browserFlowRefusal(w, http.StatusNotFound, "Box unavailable.")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	if workspace.Status == "failed" {
		browserFlowTyped(w, http.StatusConflict, "workspace_gone", "This box is gone. Open a new one.")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	return request, flowruntime.Target{
		TenantID:    "repository:" + strconv.FormatInt(view.Repository.ID, 10),
		PrincipalID: "user:" + strconv.FormatInt(user.ID, 10),
		WorkspaceID: workspace.ID, BindingKind: "browser-flow", BindingID: request.Repo,
	}, workspace, true
}

func validBrowserWorkspaceID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}

// wake answers whether the box is running. A sleeping box is resumed in the
// background, once; a resume that failed is answered to the next caller. A
// box its owner stopped is resumed only by provision, never by a read.
func (api *browserFlowAPI) wake(ctx context.Context, workspace db.Workspace, provision bool) (bool, error) {
	if workspace.Status == "running" {
		return true, nil
	}
	if err := api.resumes.Failed(workspace.ID); err != nil {
		return false, err
	}
	if workspace.Status == "suspended" || (provision && workspace.Status == "stopped") {
		api.resumes.Start(ctx, workspace.ID, func(ctx context.Context) error {
			_, err := api.boxes.ResumeWorkspace(ctx, workspace.ID, workspace.RepositoryID, workspace.UserID)
			return err
		})
	}
	return false, nil
}

// browserFlowWakeFailed answers a box that could not be resumed: a product
// refusal (a plan limit, a quota) as itself, anything else as resume failed.
func browserFlowWakeFailed(w http.ResponseWriter, err error) {
	var refusal *pkgerrors.APIError
	if errors.As(err, &refusal) {
		pkgerrors.WriteError(w, refusal)
		return
	}
	slog.Error("box resume failed", "error", err)
	browserFlowTyped(w, http.StatusServiceUnavailable, "workspace_resume_failed", "This box could not start.")
}

// provision is the box's provision-or-resume (#2198): it answers "ready" once
// the box runs and its coding host is live, so the flows list works before
// any run. Until then it wakes the box and starts the host in the
// background, answering "provisioning", which the app polls.
func (api *browserFlowAPI) provision(w http.ResponseWriter, r *http.Request) {
	_, target, workspace, ok := api.prepare(w, r, true)
	if !ok {
		return
	}
	running, err := api.wake(r.Context(), workspace, true)
	if err != nil {
		browserFlowWakeFailed(w, err)
		return
	}
	if !running {
		browserFlowProvisioning(w)
		return
	}
	ready, err := api.dispatcher.StartHost(r.Context(), target)
	if err != nil {
		browserFlowUnavailable(w, err, "provision")
		return
	}
	if !ready {
		browserFlowProvisioning(w)
		return
	}
	browserFlowJSON(w, http.StatusOK, map[string]any{
		"status": "ready", "workspaceId": target.WorkspaceID, "gatewayId": target.WorkspaceID,
	})
}

func browserFlowUnavailable(w http.ResponseWriter, err error, procedure string) {
	// A plan limit that refused the box's resume or host start is the user's
	// own answer, with its upgrade path, not an unavailable host.
	var refusal *pkgerrors.APIError
	if errors.As(err, &refusal) && refusal.Code == pkgerrors.CodePlanLimitExceeded {
		pkgerrors.WriteError(w, refusal)
		return
	}
	slog.Error("browser Flow RPC unavailable", "error", err, "procedure", procedure)
	var failure flowruntime.Failure
	if errors.As(err, &failure) {
		browserFlowTyped(w, http.StatusServiceUnavailable, failure.FlowRuntimeCode(), "Flow host unavailable.")
	} else if errors.Is(err, pgx.ErrNoRows) {
		browserFlowRefusal(w, http.StatusNotFound, "Flow host unavailable.")
	} else {
		browserFlowRefusal(w, http.StatusServiceUnavailable, "Flow host unavailable.")
	}
}

// rpc relays one procedure to the box's coding host. A snapshot of a box that
// is waking, or whose host is starting, answers "provisioning", which the app
// polls; any other procedure on a waking box is refused as workspace_starting,
// and every procedure on a box its owner stopped as workspace_stopped.
func (api *browserFlowAPI) rpc(w http.ResponseWriter, r *http.Request) {
	request, target, workspace, ok := api.prepare(w, r, false)
	if !ok {
		return
	}
	serve := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { api.relay(w, r, request, target, workspace) })
	if api.limit == nil || request.Procedure == "Projection.Snapshot" || request.Procedure == "List" {
		serve(w, r)
		return
	}
	api.limit(serve).ServeHTTP(w, r)
}

func (api *browserFlowAPI) relay(w http.ResponseWriter, r *http.Request, request browserFlowRequest, target flowruntime.Target, workspace db.Workspace) {
	snapshot := request.Procedure == "Projection.Snapshot"
	running, err := api.wake(r.Context(), workspace, false)
	if err != nil {
		browserFlowWakeFailed(w, err)
		return
	}
	switch {
	case running:
	case workspace.Status == "stopped":
		browserFlowTyped(w, http.StatusConflict, "workspace_stopped", "This box is stopped.")
		return
	case snapshot:
		browserFlowProvisioning(w)
		return
	default:
		browserFlowTyped(w, http.StatusConflict, "workspace_starting", "This box is starting.")
		return
	}
	answer, err := api.dispatcher.CallRPC(r.Context(), target, request.Procedure, request.Payload)
	var failure flowruntime.Failure
	if snapshot && errors.As(err, &failure) && (failure.FlowRuntimeCode() == "runtime_host_not_running" || failure.FlowRuntimeCode() == "runtime_host_starting") {
		if _, err = api.dispatcher.StartHost(r.Context(), target); err == nil {
			browserFlowProvisioning(w)
			return
		}
	}
	if err != nil {
		browserFlowUnavailable(w, err, request.Procedure)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(answer)
}
