package compose

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

const registrationReview = "register-repository/review"
const registrationNote = "register-repository/decline-note"

func registrationWait(name string) bool {
	name, _, _ = strings.Cut(name, "#")
	return name == registrationReview || name == registrationNote
}

// Use the same admin and person checks for both doors. Owning a workspace or
// holding its execution credential never grants the right to review it.
func registrationAdmin(w http.ResponseWriter, r *http.Request, write bool) bool {
	allowed := false
	next := http.Handler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := middleware.RequirePerson(r.Context(), "review a repository registration"); err != nil {
			browserFlowWakeFailed(w, err)
			return
		}
		allowed = true
	}))
	if write {
		next = middleware.RequireScope(middleware.ScopeWriteAdmin)(next)
	}
	middleware.RequireAdmin(next).ServeHTTP(w, r)
	return allowed
}

func registrationDecision(payload json.RawMessage, procedure string) bool {
	var field, name string
	switch procedure {
	case "Approval.Submit":
		field, name = "target", "requestId"
	case "Signal":
		field, name = "signal", "name"
	default:
		return false
	}
	// Match the runtime's case-sensitive JSON keys. Struct decoding folds case
	// and lets an unrelated field hide the real target from this guard.
	var input map[string]json.RawMessage
	if json.Unmarshal(payload, &input) != nil {
		return false
	}
	var target map[string]json.RawMessage
	if json.Unmarshal(input[field], &target) != nil {
		return false
	}
	var wait string
	return json.Unmarshal(target[name], &wait) == nil && registrationWait(wait)
}

type registrationDestination struct {
	Repo        string `json:"repo"`
	WorkspaceID string `json:"workspaceId"`
}

type registrationInbox struct {
	registrationDestination
	Rows  []json.RawMessage `json:"rows"`
	Error string            `json:"error,omitempty"`
}

func (api *browserFlowAPI) registrationTarget(ctx context.Context, workspaceID string) (registrationDestination, flowruntime.Target, db.Workspace, error) {
	if api.registrationPool == nil || !validBrowserWorkspaceID(workspaceID) {
		return registrationDestination{}, flowruntime.Target{}, db.Workspace{}, pkgerrors.NotFound("Registration unavailable.")
	}
	q := db.New(api.registrationPool)
	workspace, err := q.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return registrationDestination{}, flowruntime.Target{}, workspace, pkgerrors.NotFound("Registration unavailable.")
	}
	var repo string
	// The existing host binding is the durable directory. Its execution owner is
	// the registrant, even when a different person submits this one decision.
	err = api.registrationPool.QueryRow(ctx, `SELECT COALESCE(u.username,o.name)||'/'||r.name
 FROM flow_runtime_host_bindings h JOIN repositories r ON r.id=h.repository_id
 LEFT JOIN users u ON u.id=r.user_id LEFT JOIN organizations o ON o.id=r.org_id
 WHERE h.workspace_id=$1 AND h.catalog_key='coding' AND h.repository_id=$2 AND h.user_id=$3`, workspaceID, workspace.RepositoryID, workspace.UserID).Scan(&repo)
	if err != nil {
		return registrationDestination{}, flowruntime.Target{}, workspace, pkgerrors.NotFound("Registration unavailable.")
	}
	destination := registrationDestination{Repo: repo, WorkspaceID: workspace.ID}
	target := flowruntime.Target{TenantID: "repository:" + strconv.FormatInt(workspace.RepositoryID, 10), PrincipalID: "user:" + strconv.FormatInt(workspace.UserID, 10), WorkspaceID: workspace.ID, BindingKind: "browser-flow", BindingID: repo}
	if workspace.RebuildRequiredAt.Valid && !api.subscriptionTokens {
		return destination, target, workspace, pkgerrors.Conflict(browserFlowRebuildRequired)
	}
	return destination, target, workspace, nil
}

func (api *browserFlowAPI) registrationReady(ctx context.Context, target flowruntime.Target, workspace db.Workspace) error {
	running, err := api.wake(ctx, workspace, false)
	if err != nil {
		return err
	}
	if !running {
		return pkgerrors.Conflict("Registration workspace is not running.")
	}
	ready, err := api.dispatcher.StartHost(ctx, target)
	if err != nil {
		return err
	}
	if !ready {
		return pkgerrors.Conflict("Registration workspace is starting.")
	}
	return nil
}

func (api *browserFlowAPI) registrationSnapshot(ctx context.Context, target flowruntime.Target, selector any) ([]json.RawMessage, error) {
	payload, _ := json.Marshal(map[string]any{"selector": selector})
	answer, err := api.dispatcher.CallRPC(ctx, target, "Projection.Snapshot", payload)
	if err != nil {
		return nil, err
	}
	var result struct {
		OK      bool `json:"ok"`
		Payload struct {
			Rows []json.RawMessage `json:"rows"`
		} `json:"payload"`
	}
	if json.Unmarshal(answer, &result) != nil || !result.OK || result.Payload.Rows == nil {
		return nil, errors.New("registration projection unavailable")
	}
	return result.Payload.Rows, nil
}

// Only the named builtin's two human waits are exposed. A capability grant or
// an unrelated flow using a similar question name is not an admin review.
func (api *browserFlowAPI) registrationRows(ctx context.Context, target flowruntime.Target) ([]json.RawMessage, error) {
	runs, err := api.registrationSnapshot(ctx, target, map[string]string{"_tag": "workspace-runs"})
	if err != nil {
		return nil, err
	}
	registrations := map[string]bool{}
	for _, raw := range runs {
		var run struct {
			RunID  string `json:"runId"`
			FlowID string `json:"flowId"`
		}
		if json.Unmarshal(raw, &run) == nil && run.FlowID == "register-repository" {
			registrations[run.RunID] = true
		}
	}
	if len(registrations) == 0 {
		return []json.RawMessage{}, nil
	}
	rows, err := api.registrationSnapshot(ctx, target, map[string]string{"_tag": "approvals"})
	if err != nil {
		return nil, err
	}
	selected := []json.RawMessage{}
	for _, raw := range rows {
		var row struct {
			RunID   string `json:"runId"`
			Status  string `json:"status"`
			Request struct {
				Name  string `json:"name"`
				Token string `json:"token"`
			} `json:"request"`
			Payload struct {
				Target struct {
					Tag       string `json:"_tag"`
					Digest    string `json:"digest"`
					RequestID string `json:"requestId"`
					RunID     string `json:"runId"`
				} `json:"target"`
			} `json:"payload"`
		}
		if json.Unmarshal(raw, &row) == nil && registrations[row.RunID] && row.Status == "pending" && registrationWait(row.Request.Name) &&
			row.Payload.Target.Tag == "Node" && row.Payload.Target.RunID == row.RunID && row.Request.Token != "" && row.Payload.Target.Digest == row.Request.Token &&
			strings.Split(row.Payload.Target.RequestID, "#")[0] == row.Request.Name {
			selected = append(selected, raw)
		}
	}
	return selected, nil
}

func (api *browserFlowAPI) registrationRPC(w http.ResponseWriter, r *http.Request, request browserFlowRequest) {
	write := request.Procedure == "Approval.Submit"
	if !registrationAdmin(w, r, write) {
		return
	}
	if api.registrationPool == nil {
		browserFlowRefusal(w, 503, "Registration reviews unavailable.")
		return
	}
	if !write {
		api.registrationList(w, r, request.Payload)
		return
	}
	if !validBrowserWorkspaceID(request.WorkspaceID) {
		browserFlowRefusal(w, 400, "Name the registration workspace.")
		return
	}
	_, target, workspace, err := api.registrationTarget(r.Context(), request.WorkspaceID)
	if err == nil {
		err = api.registrationReady(r.Context(), target, workspace)
	}
	if err != nil {
		browserFlowWakeFailed(w, err)
		return
	}
	rows, err := api.registrationRows(r.Context(), target)
	if err != nil {
		browserFlowUnavailable(w, err, request.Procedure)
		return
	}
	var decision map[string]json.RawMessage
	if json.Unmarshal(request.Payload, &decision) != nil {
		browserFlowRefusal(w, 400, "Invalid review answer.")
		return
	}
	var choice, answer string
	_ = json.Unmarshal(decision["decision"], &choice)
	if choice != "approve" || json.Unmarshal(decision["answer"], &answer) != nil {
		browserFlowRefusal(w, 400, "Answer the review question.")
		return
	}
	for _, raw := range rows {
		var row struct {
			Payload map[string]json.RawMessage `json:"payload"`
			Request struct {
				Name string `json:"name"`
			} `json:"request"`
		}
		if json.Unmarshal(raw, &row) != nil {
			continue
		}
		if !sameRegistrationJSON(row.Payload["target"], decision["target"]) || !sameRegistrationJSON(row.Payload["scope"], decision["scope"]) || !sameRegistrationJSON(row.Payload["idempotencyKey"], decision["idempotencyKey"]) {
			continue
		}
		if (row.Request.Name == registrationReview && answer != "Approve" && answer != "Decline") || (row.Request.Name == registrationNote && (strings.TrimSpace(answer) == "" || len(answer) > 2000)) {
			browserFlowRefusal(w, 400, "Invalid review answer.")
			return
		}
		// Relay the host's own authority-bearing fields, never extra client fields.
		row.Payload["decision"] = json.RawMessage(`"approve"`)
		row.Payload["answer"], _ = json.Marshal(answer)
		payload, _ := json.Marshal(row.Payload)
		result, err := api.dispatcher.CallRPC(r.Context(), target, "Approval.Submit", payload)
		if err != nil {
			browserFlowUnavailable(w, err, "Approval.Submit")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(result)
		return
	}
	browserFlowRefusal(w, 409, "This registration review is no longer pending.")
}

func sameRegistrationJSON(a, b json.RawMessage) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return false
	}
	l, _ := json.Marshal(left)
	rr, _ := json.Marshal(right)
	return string(l) == string(rr)
}

func (api *browserFlowAPI) registrationList(w http.ResponseWriter, r *http.Request, payload json.RawMessage) {
	var input struct {
		After string `json:"after"`
	}
	if len(payload) > 0 && json.Unmarshal(payload, &input) != nil {
		browserFlowRefusal(w, 400, "Invalid inbox cursor.")
		return
	}
	if input.After != "" && !validBrowserWorkspaceID(input.After) {
		browserFlowRefusal(w, 400, "Invalid inbox cursor.")
		return
	}
	// Page the existing host directory, not an in-memory launch index. It remains
	// available after backend restarts and includes sleeping workspace hosts.
	rows, err := api.registrationPool.Query(r.Context(), `SELECT workspace_id::text FROM flow_runtime_host_bindings WHERE catalog_key='coding' AND state <> 'retired' AND ($1='' OR workspace_id::text>$1) ORDER BY workspace_id::text LIMIT 11`, input.After)
	if err != nil {
		browserFlowUnavailable(w, err, "Registration.Reviews")
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		browserFlowUnavailable(w, err, "Registration.Reviews")
		return
	}
	next := ""
	if len(ids) > 10 {
		ids = ids[:10]
		next = ids[9]
	}
	inbox := []registrationInbox{}
	for _, id := range ids {
		destination, target, workspace, err := api.registrationTarget(r.Context(), id)
		if err == nil {
			err = api.registrationReady(r.Context(), target, workspace)
		}
		item := registrationInbox{registrationDestination: destination, Rows: []json.RawMessage{}}
		if err == nil {
			item.Rows, err = api.registrationRows(r.Context(), target)
		}
		if err != nil {
			item.Rows = []json.RawMessage{}
			item.WorkspaceID = id
			item.Error = "Registration reviews unavailable. Retry."
		}
		inbox = append(inbox, item)
	}
	browserFlowJSON(w, 200, map[string]any{"ok": true, "payload": map[string]any{"inboxes": inbox, "next": next}})
}
