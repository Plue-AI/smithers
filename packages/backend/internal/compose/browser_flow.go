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
	dispatcher *flowdispatch.Service
	// subscriptionTokens mirrors feature_flags.subscription_connections.
	subscriptionTokens bool
}

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

func (api *browserFlowAPI) prepare(w http.ResponseWriter, r *http.Request, provision bool) (browserFlowRequest, flowruntime.Target, bool) {
	var request browserFlowRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	// Every flow runs on a box: its coding host serves the catalog. There is
	// no repository-level host to fall back to (#2194).
	if decoder.Decode(&request) != nil || !browserFlowRepo.MatchString(request.Repo) || !validBrowserWorkspaceID(request.WorkspaceID) {
		browserFlowRefusal(w, http.StatusBadRequest, "Body must name a repository and a box (workspaceId).")
		return request, flowruntime.Target{}, false
	}
	if !provision && !browserFlowProcedures[request.Procedure] {
		browserFlowRefusal(w, http.StatusBadRequest, "The workflow seam does not relay this procedure.")
		return request, flowruntime.Target{}, false
	}
	user := middleware.UserFromContext(r.Context())
	if user == nil {
		browserFlowRefusal(w, http.StatusUnauthorized, "Sign in to run flows.")
		return request, flowruntime.Target{}, false
	}
	owner, name, _ := strings.Cut(request.Repo, "/")
	view, err := api.repos.GetRepoView(r.Context(), user, owner, name)
	if err != nil || !view.CanWrite {
		browserFlowRefusal(w, http.StatusNotFound, "Repository unavailable.")
		return request, flowruntime.Target{}, false
	}
	workspace, err := api.queries.GetWorkspaceForUserRepo(r.Context(), db.GetWorkspaceForUserRepoParams{
		ID: request.WorkspaceID, RepositoryID: view.Repository.ID, UserID: user.ID,
	})
	if err == nil && workspace.RebuildRequiredAt.Valid && !api.subscriptionTokens {
		browserFlowRefusal(w, http.StatusConflict, browserFlowRebuildRequired)
		return request, flowruntime.Target{}, false
	}
	if err != nil || workspace.Status != "running" {
		browserFlowRefusal(w, http.StatusNotFound, "Box unavailable.")
		return request, flowruntime.Target{}, false
	}
	return request, flowruntime.Target{
		TenantID:    "repository:" + strconv.FormatInt(view.Repository.ID, 10),
		PrincipalID: "user:" + strconv.FormatInt(user.ID, 10),
		WorkspaceID: workspace.ID, BindingKind: "browser-flow", BindingID: request.Repo,
	}, true
}

func validBrowserWorkspaceID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}

func (api *browserFlowAPI) provision(w http.ResponseWriter, r *http.Request) {
	_, target, ok := api.prepare(w, r, true)
	if !ok {
		return
	}
	browserFlowJSON(w, http.StatusOK, map[string]any{
		"status": "ready", "workspaceId": target.WorkspaceID, "gatewayId": target.WorkspaceID,
	})
}

func (api *browserFlowAPI) rpc(w http.ResponseWriter, r *http.Request) {
	request, target, ok := api.prepare(w, r, false)
	if !ok {
		return
	}
	answer, err := api.dispatcher.CallRPC(r.Context(), target, request.Procedure, request.Payload)
	if err != nil {
		slog.Error("browser Flow RPC unavailable", "error", err, "procedure", request.Procedure)
		var failure flowruntime.Failure
		if errors.As(err, &failure) {
			browserFlowJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": map[string]string{
				"code": failure.FlowRuntimeCode(), "message": "Flow host unavailable.",
			}})
		} else if errors.Is(err, pgx.ErrNoRows) {
			browserFlowRefusal(w, http.StatusNotFound, "Flow host unavailable.")
		} else {
			browserFlowRefusal(w, http.StatusServiceUnavailable, "Flow host unavailable.")
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(answer)
}
