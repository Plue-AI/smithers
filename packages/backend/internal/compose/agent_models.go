package compose

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/modelhost"
)

// Factory roles use the install's existing model bindings; no separate store.
func agentRole(role string) bool {
	switch role {
	case "planner", "implementer", "reviewer", "app", "fast", "coding", "jev":
		return true
	}
	return false
}

func agentBinding(ctx context.Context, q *db.Queries, role string) (json.RawMessage, string, error) {
	value, err := q.EffectiveInstallAgentModel(ctx, role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "builtin", nil
	}
	return value, "owner", err
}

func agentProfiles(ctx context.Context, q *db.Queries) (map[string]any, error) {
	profiles := []map[string]any{}
	appRuns, err := q.RecentAppAgentRuns(ctx)
	if err != nil {
		return nil, err
	}
	for _, role := range []string{"planner", "implementer", "reviewer", "app"} {
		binding, source, err := agentBinding(ctx, q, role)
		if err != nil {
			return nil, err
		}
		var model struct {
			ModelID  string `json:"modelId"`
			Protocol string `json:"protocol"`
		}
		if len(binding) > 0 && json.Unmarshal(binding, &model) != nil {
			return nil, errors.New("invalid agent model")
		}
		modelLabel := model.ModelID
		if model.ModelID == "" {
			model.ModelID = "unconfigured"
		}
		path := "flows/todo/flow.ts"
		label := strings.ToUpper(role[:1]) + role[1:] + " agent"
		if role == "app" {
			path = ".smithers/instructions/app.md"
			label = "App agent"
		}
		runs := []db.AgentModelRun{}
		if role == "app" {
			runs = appRuns
		} else {
			runs, err = q.RecentFactoryAgentRuns(ctx, role)
			if err != nil {
				return nil, err
			}
		}
		profiles = append(profiles, map[string]any{"id": role, "label": label, "purpose": "", "builtin": true, "available": false, "reason": "", "account": "",
			"model": map[string]string{"id": model.ModelID, "label": modelLabel, "provider": model.Protocol}, "source": source, "binding": binding, "instructions": path, "runs": runs})
	}
	bindings := map[string]json.RawMessage{}
	for _, role := range []string{"fast", "coding", "jev"} {
		binding, _, err := agentBinding(ctx, q, role)
		if err != nil {
			return nil, err
		}
		bindings[role] = binding
	}
	return map[string]any{"native": false, "install": true, "agents": profiles, "roleBindings": bindings}, nil
}

func serveAgents(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		value, err := agentProfiles(r.Context(), q)
		if err != nil {
			routes.WriteInstallSetupError(w, r, pkgerrors.Internal("Could not read agents"))
			return
		}
		owner, ownerErr := q.GetSelfHostOwner(r.Context())
		info := middleware.AuthInfoFromContext(r.Context())
		value["canAssign"] = ownerErr == nil && middleware.IsOwnerBrowserSession(info, owner.ID)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(value)
	}
}

func assignAgentModel(q *db.Queries) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role := chi.URLParam(r, "role")
		if !agentRole(role) {
			routes.WriteInstallSetupError(w, r, pkgerrors.BadRequest("Unknown agent"))
			return
		}
		var input struct {
			Model struct {
				Protocol   string `json:"protocol"`
				ModelID    string `json:"modelId"`
				Credential string `json:"credential"`
				BaseURL    string `json:"baseUrl,omitempty"`
				Path       string `json:"path,omitempty"`
			} `json:"model"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384))
		decoder.DisallowUnknownFields()
		err := decoder.Decode(&input)
		var trailing any
		if err != nil || decoder.Decode(&trailing) != io.EOF || strings.TrimSpace(input.Model.ModelID) == "" || len(input.Model.ModelID) > 81 || strings.TrimSpace(input.Model.Credential) == "" ||
			(input.Model.Protocol != "openai-chat" && input.Model.Protocol != "openai-responses" && input.Model.Protocol != "anthropic-messages" && !(role == "jev" && input.Model.Protocol == "evaluation")) {
			routes.WriteInstallSetupError(w, r, pkgerrors.BadRequest("Invalid model"))
			return
		}
		value, _ := json.Marshal(input.Model)
		if !modelhost.ValidModelBinding(value) {
			routes.WriteInstallSetupError(w, r, pkgerrors.BadRequest("Invalid model"))
			return
		}
		if err = q.AssignInstallAgentModel(r.Context(), role, value); err != nil {
			routes.WriteInstallSetupError(w, r, pkgerrors.Internal("Could not save model"))
			return
		}
		serveAgents(q)(w, r)
	}
}
