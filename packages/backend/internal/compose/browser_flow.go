package compose

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/cors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/config"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/background"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

var browserFlowRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// The procedure set is the product relay contract the app speaks.
// All payload and result bodies remain canonical Control/Gateway RPC shapes.
var browserFlowProcedures = map[string]bool{
	"Plan": true, "Run": true, "Cancel": true, "Resume": true,
	"Steer": true, "Signal": true, "List": true,
	"Projection.Snapshot": true, "Approval.Submit": true,
	"Run.Fork": true, "Run.Verify": true,
}

type browserFlowAPI struct {
	// Set by the install composition; Plue retains its repository ACL gates.
	installQueries      *db.Queries
	install             bool
	installTransactions interface {
		Begin(context.Context) (pgx.Tx, error)
	}
	repos interface {
		GetRepoView(context.Context, *db.User, string, string) (services.RepoView, error)
	}
	// queries finds the named box: the caller's own, or a TODO's lane shared
	// with the caller alone (GetFlowWorkspaceForUserRepo).
	queries interface {
		GetFlowWorkspaceForUserRepo(context.Context, db.GetFlowWorkspaceForUserRepoParams) (db.Workspace, error)
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
}

// browserFlowDispatcher is the box's flow seam (flowdispatch.Service).
type browserFlowDispatcher interface {
	CallRPC(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error)
	StartHost(context.Context, flowruntime.Target) (bool, error)
	RefuseRelay(context.Context, flowruntime.Target, string, json.RawMessage) error
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
// browserFlowTodoRefused answers a relay call that would plan, run, resume
// or fork the todo composition outside the stack's pinned launch.
// browserFlowRelayRefused answers a relay call refused before the box woke.
func browserFlowRelayRefused(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, flowdispatch.ErrTodoOutsideStack):
		browserFlowTodoRefused(w)
	case errors.Is(err, flowdispatch.ErrEngineFlowOutsideStack):
		browserFlowTyped(w, http.StatusForbidden, "engine_only_flow", "File a TODO.")
	case errors.Is(err, flowdispatch.ErrRelayPlanUnknown):
		browserFlowTyped(w, http.StatusConflict, "plan_unknown", "Plan again.")
	default:
		browserFlowRefusal(w, http.StatusBadRequest, "Invalid workflow request.")
	}
}

func browserFlowTodoRefused(w http.ResponseWriter) {
	browserFlowTyped(w, http.StatusForbidden, "todo_requires_stack_admission", "File a TODO to run the todo flow.")
}

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
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	// Every flow runs on a box: its coding host serves the catalog. There is
	// no repository-level host to fall back to (#2194).
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || !browserFlowRepo.MatchString(request.Repo) || !validBrowserWorkspaceID(request.WorkspaceID) {
		browserFlowRefusal(w, http.StatusBadRequest, "Body must name a repository and a box (workspaceId).")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	if !provision && (strings.HasPrefix(request.Procedure, "Registration.") || retiredRegistrationDecision(request.Payload, request.Procedure)) {
		browserFlowJSON(w, http.StatusNotFound, map[string]string{"code": "registration_retired", "class": "user", "message": "Registration is unavailable."})
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	if !provision && !browserFlowProcedures[request.Procedure] {
		browserFlowRefusal(w, http.StatusBadRequest, "The workflow seam does not relay this procedure.")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	if api.install {
		command := "box.resume"
		if !provision {
			var err error
			command, err = browserFlowCommand(request)
			if err != nil {
				writeConfirmationDispatchError(w, err)
				return request, flowruntime.Target{}, db.Workspace{}, false
			}
		}
		subject, lookup := api.installSubject(r.Context(), request)
		decision, err := services.Authorize(r.Context(), api.installQueries, command, subject)
		if err != nil {
			writeConfirmationDispatchError(w, err)
			return request, flowruntime.Target{}, db.Workspace{}, false
		}
		if lookup != nil {
			writeConfirmationDispatchError(w, lookup)
			return request, flowruntime.Target{}, db.Workspace{}, false
		}
		*r = *r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject))
	} else if !provision {
		var action string
		switch request.Procedure {
		case "Approval.Submit":
			action = "decide an approval"
		case "Cancel", "Signal", "Resume", "Steer":
			action = "control a run"
		case "Plan", "Run":
			action = "start a run"
		case "Run.Fork", "Run.Verify":
			action = "fork or verify a run"
		}
		if action != "" {
			if err := middleware.RequirePerson(r.Context(), action); err != nil {
				browserFlowWakeFailed(w, err)
				return request, flowruntime.Target{}, db.Workspace{}, false
			}
		}
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
	workspace, err := api.queries.GetFlowWorkspaceForUserRepo(r.Context(), db.GetFlowWorkspaceForUserRepoParams{
		ID: request.WorkspaceID, RepositoryID: view.Repository.ID, UserID: user.ID,
	})
	if err == nil && workspace.RebuildRequiredAt.Valid {
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
	// A box the caller does not own is a TODO's lane: the stack runs it. Its
	// person reads its runs here and acts on them through the TODO
	// (/api/todos), never through the relay.
	if !provision && workspace.UserID != user.ID && request.Procedure != "List" && request.Procedure != "Projection.Snapshot" {
		browserFlowTyped(w, http.StatusForbidden, "todo_requires_stack_admission", "This branch runs a TODO. Act on the TODO.")
		return request, flowruntime.Target{}, db.Workspace{}, false
	}
	bindingKind := "browser-flow"
	if strings.HasPrefix(workspace.TargetBookmark, "scratch/") {
		bindingKind = flowdispatch.DraftBindingKind
	}
	return request, flowruntime.Target{
		TenantID:    "repository:" + strconv.FormatInt(view.Repository.ID, 10),
		PrincipalID: "user:" + strconv.FormatInt(user.ID, 10),
		WorkspaceID: workspace.ID, BindingKind: bindingKind, BindingID: request.Repo,
	}, workspace, true
}

// installSubject binds the decoded relay request to its stored workspace. The
// guest's current host lease still decides whether that workspace can execute.
func (api *browserFlowAPI) installSubject(ctx context.Context, request browserFlowRequest) (services.InstallSubject, error) {
	denied := &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"}
	if api.installQueries == nil {
		return services.InstallSubject{}, denied
	}
	owner, name, _ := strings.Cut(request.Repo, "/")
	repository, err := api.installQueries.GetRepoByOwnerAndLowerName(ctx, db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(owner), LowerName: strings.ToLower(name)})
	if err != nil {
		return services.InstallSubject{}, denied
	}
	installed, err := services.InstallRepositoryID(ctx, api.installQueries)
	if err != nil {
		return services.InstallSubject{}, err
	}
	if installed != repository.ID {
		return services.InstallSubject{}, denied
	}
	user := middleware.UserFromContext(ctx)
	if user == nil {
		return services.InstallSubject{}, denied
	}
	workspace, err := api.installQueries.GetFlowWorkspaceForUserRepo(ctx, db.GetFlowWorkspaceForUserRepoParams{
		ID: request.WorkspaceID, RepositoryID: repository.ID, UserID: user.ID,
	})
	if err != nil || workspace.RepositoryID != repository.ID || workspace.DeletedAt.Valid {
		return services.InstallSubject{}, denied
	}
	raw, err := json.Marshal(struct {
		Request      browserFlowRequest
		Owner        int64
		Status, Kind string
		Rebuild      bool
	}{request, workspace.UserID, workspace.Status, workspace.Kind, workspace.RebuildRequiredAt.Valid})
	if err != nil {
		return services.InstallSubject{}, denied
	}
	digest := sha256.Sum256(raw)
	return services.InstallSubject{RepositoryID: repository.ID, WorkspaceID: workspace.ID,
		Source: workspace.TargetBookmark, Base: workspace.VmID, Generation: int64(workspace.ProvisioningGeneration),
		Resource: request.Procedure, PayloadDigest: hex.EncodeToString(digest[:])}, nil
}

// Reuse the original decision after the limiter and before each admission.
// A replaced payload, workspace generation or relay target cannot inherit it.
func (api *browserFlowAPI) checkInstallBinding(ctx context.Context, request browserFlowRequest, target flowruntime.Target, provision bool) error {
	if !api.install {
		return nil
	}
	subject, err := api.installSubject(ctx, request)
	if err != nil {
		return err
	}
	command := "box.resume"
	if !provision {
		command, err = browserFlowCommand(request)
		if err != nil {
			return err
		}
	}
	decision, err := services.Authorize(ctx, api.installQueries, command, subject)
	if err != nil {
		return err
	}
	kind := "browser-flow"
	if strings.HasPrefix(subject.Source, "scratch/") {
		kind = flowdispatch.DraftBindingKind
	}
	if target.TenantID != "repository:"+strconv.FormatInt(subject.RepositoryID, 10) ||
		target.PrincipalID != "user:"+strconv.FormatInt(decision.UserID, 10) ||
		target.WorkspaceID != subject.WorkspaceID || target.BindingKind != kind || target.BindingID != request.Repo {
		return &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"}
	}
	return nil
}

func (api *browserFlowAPI) withInstallEffect(ctx context.Context, request browserFlowRequest, target flowruntime.Target, provision bool, effect func(context.Context) error) error {
	if !api.install {
		return effect(ctx)
	}
	return services.WithInstallCredentialFence(ctx, api.installTransactions, func(ctx context.Context) error {
		if err := api.checkInstallBinding(ctx, request, target, provision); err != nil {
			return err
		}
		return effect(ctx)
	})
}

func validBrowserWorkspaceID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}

// wake answers whether the box is running. A sleeping box is resumed in the
// background, once; a resume that failed is answered to the next caller. A
// box its owner stopped is resumed only by provision, never by a read.
func (api *browserFlowAPI) wake(ctx context.Context, request browserFlowRequest, target flowruntime.Target, workspace db.Workspace, provision bool) (bool, error) {
	if workspace.Status == "running" {
		return true, nil
	}
	if err := api.resumes.Failed(workspace.ID); err != nil {
		return false, err
	}
	if workspace.Status == "suspended" || (provision && workspace.Status == "stopped") {
		api.resumes.Start(ctx, workspace.ID, func(ctx context.Context) error {
			return api.withInstallEffect(ctx, request, target, provision, func(ctx context.Context) error {
				_, err := api.boxes.ResumeWorkspace(ctx, workspace.ID, workspace.RepositoryID, workspace.UserID)
				return err
			})
		})
	}
	return false, nil
}

// browserFlowWakeFailed answers a box that could not be resumed: a product
// refusal (a plan limit, a quota) as itself, anything else as resume failed.
func browserFlowWakeFailed(w http.ResponseWriter, err error) {
	var access *services.AccessError
	if errors.As(err, &access) {
		writeConfirmationDispatchError(w, err)
		return
	}
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
	request, target, workspace, ok := api.prepare(w, r, true)
	if !ok {
		return
	}
	if err := api.checkInstallBinding(r.Context(), request, target, true); err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	running, err := api.wake(r.Context(), request, target, workspace, true)
	if err != nil {
		browserFlowWakeFailed(w, err)
		return
	}
	if !running {
		browserFlowProvisioning(w)
		return
	}
	var ready bool
	err = api.withInstallEffect(r.Context(), request, target, true, func(ctx context.Context) error {
		var err error
		ready, err = api.dispatcher.StartHost(ctx, target)
		return err
	})
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
	var access *services.AccessError
	if errors.As(err, &access) {
		writeConfirmationDispatchError(w, err)
		return
	}
	// A plan limit that refused the box's resume or host start is the user's
	// own answer, with its upgrade path, not an unavailable host. A box whose
	// coding host could not be readied (a helper refresh that failed, #3111)
	// answers that typed reason instead of a host outage the app would retry.
	var refusal *pkgerrors.APIError
	if errors.As(err, &refusal) && (refusal.Code == pkgerrors.CodePlanLimitExceeded || refusal.Code == pkgerrors.CodeCodingHostUnavailable) {
		pkgerrors.WriteError(w, refusal)
		return
	}
	if errors.Is(err, flowdispatch.ErrTodoOutsideStack) {
		browserFlowTodoRefused(w)
		return
	}
	if errors.Is(err, flowdispatch.ErrEngineFlowOutsideStack) {
		browserFlowTyped(w, http.StatusForbidden, "engine_only_flow", "File a TODO.")
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
// is waking answers "provisioning", which the app polls; a read (snapshot,
// List) of a running box whose host is down starts it and answers the same; any other procedure on a waking box is refused as workspace_starting,
// and every procedure on a box its owner stopped as workspace_stopped.
func (api *browserFlowAPI) rpc(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		browserFlowRefusal(w, 400, "Invalid workflow request.")
		return
	}
	r.Body = io.NopCloser(strings.NewReader(string(body)))
	request, target, workspace, ok := api.prepare(w, r, false)
	if !ok {
		return
	}
	// The todo composition runs only from a filed TODO's pinned stack launch:
	// a call the relay can classify without the box's host (a plan, a run
	// of a saved plan, an unreadable payload) is refused before the box
	// wakes.
	if err := api.dispatcher.RefuseRelay(r.Context(), target, request.Procedure, append(json.RawMessage(nil), request.Payload...)); err != nil {
		browserFlowRelayRefused(w, err)
		return
	}
	serve := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		api.relay(w, r, request, target, workspace)
	})
	if api.limit == nil || request.Procedure == "Projection.Snapshot" || request.Procedure == "List" {
		serve(w, r)
		return
	}
	api.limit(serve).ServeHTTP(w, r)
}

func (api *browserFlowAPI) relay(w http.ResponseWriter, r *http.Request, request browserFlowRequest, target flowruntime.Target, workspace db.Workspace) {
	snapshot := request.Procedure == "Projection.Snapshot"
	if err := api.checkInstallBinding(r.Context(), request, target, false); err != nil {
		writeConfirmationDispatchError(w, err)
		return
	}
	// A read never wakes a sleeping or stopped box: a run it ran is served
	// from its host's own answers, retained while the host was live.
	if snapshot && workspace.Status != "running" {
		if answer, ok := api.archivedSnapshot(r.Context(), workspace, request.Payload); ok {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(answer)
			return
		}
	}
	running, err := api.wake(r.Context(), request, target, workspace, false)
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
	var answer json.RawMessage
	err = api.withInstallEffect(r.Context(), request, target, false, func(ctx context.Context) error {
		var err error
		answer, err = api.dispatcher.CallRPC(ctx, target, request.Procedure, request.Payload)
		return err
	})
	var failure flowruntime.Failure
	if (snapshot || request.Procedure == "List") && errors.As(err, &failure) && (failure.FlowRuntimeCode() == "runtime_host_not_running" || failure.FlowRuntimeCode() == "runtime_host_starting") {
		if err = api.withInstallEffect(r.Context(), request, target, false, func(ctx context.Context) error {
			_, err := api.dispatcher.StartHost(ctx, target)
			return err
		}); err == nil {
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

// archivedSnapshot answers a run snapshot on box from the run archive, when
// the archive holds that run and selector. The relay's authorization of the
// box and repository precedes it; the archive is keyed by both.
func (api *browserFlowAPI) archivedSnapshot(ctx context.Context, box db.Workspace, payload json.RawMessage) (json.RawMessage, bool) {
	reader, ok := api.installTransactions.(runArchiveReader)
	if !ok {
		return nil, false
	}
	var request struct {
		Selector struct {
			RunID string `json:"runId"`
		} `json:"selector"`
	}
	if json.Unmarshal(payload, &request) != nil || request.Selector.RunID == "" {
		return nil, false
	}
	archived, err := readRunArchive(ctx, reader, box.RepositoryID, box.ID, request.Selector.RunID)
	if err != nil {
		return nil, false
	}
	answer, ok, err := archived.snapshot(ctx, payload)
	return answer, ok && err == nil
}

// mountBrowserFlow serves the browser Flow seam. The OpenAPI conformance test
// walks the same mounts.
func mountBrowserFlow(router chi.Router, cfg *config.Config, queries *db.Queries, browser *browserFlowAPI) {
	browser.install = config.IsSingleOwner(cfg.Auth)
	browser.installQueries = queries
	access := func(limited bool) []func(http.Handler) http.Handler {
		chain := []func(http.Handler) http.Handler{
			cors.Handler(apiCORSOptions(cfg)), middleware.JSONTimeout(4 * time.Minute),
			middleware.JSONAllowContentType("application/json"), middleware.MaxBodySize(middleware.MaxRequestBodySize),
			authLoader(queries, cfg.Auth), apiCSRFMiddleware,
		}
		if limited {
			chain = append(chain, middleware.GlobalAPIRateLimit(queries))
		}
		return append(chain, middleware.RequireAuth, middleware.RequireScope(middleware.ScopeWriteRepository))
	}
	flowAccess := access(true)
	router.With(flowAccess...).Post("/api/workflow/provision", browser.provision)
	// The seam takes the API budget itself: a run's progress polls (a
	// snapshot every two seconds per run) stay out of it (browserFlowAPI.limit).
	router.With(access(false)...).Post("/api/workflow/rpc", browser.rpc)
}

// retiredRegistrationDecision preserves the old wait classifier so persisted
// registration waits cannot regain a write door through the generic relay.
func retiredRegistrationDecision(payload json.RawMessage, procedure string) bool {
	var field, name string
	switch procedure {
	case "Approval.Submit":
		field, name = "target", "requestId"
	case "Signal":
		field, name = "signal", "name"
	default:
		return false
	}
	var input, target map[string]json.RawMessage
	if json.Unmarshal(payload, &input) != nil || json.Unmarshal(input[field], &target) != nil {
		return false
	}
	var wait string
	if json.Unmarshal(target[name], &wait) != nil {
		return false
	}
	wait, _, _ = strings.Cut(wait, "#")
	return wait == "register-repository/review" || wait == "register-repository/decline-note"
}

// browserFlowCommand resolves the concrete action before the relay can wake a
// workspace or reach its host. In particular, approval is never generic run
// authority and cannot acquire permission from caller-supplied attribution.
func browserFlowCommand(request browserFlowRequest) (string, error) {
	switch request.Procedure {
	case "Plan":
		return "flow.plan", nil
	case "Run", "Run.Verify":
		return "flow.run", nil
	case "Run.Fork":
		return "branch.fork", nil
	case "Cancel":
		return "runs.cancel", nil
	case "Resume":
		return "runs.resume", nil
	case "Signal", "Steer":
		return "runs.signal", nil
	case "List":
		return "runs.list", nil
	case "Projection.Snapshot":
		return "runs.steps", nil
	case "Approval.Submit":
		var input struct {
			Decision string `json:"decision"`
		}
		if json.Unmarshal(request.Payload, &input) == nil {
			switch input.Decision {
			case "approve":
				return "approval.approve", nil
			case "deny":
				return "approval.deny", nil
			}
		}
	}
	return "", &services.AccessError{Status: 400, Class: "user", Code: "invalid_workflow", Message: "Invalid workflow request"}
}
