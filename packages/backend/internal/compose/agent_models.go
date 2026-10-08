package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/modelhost"
	"github.com/smithersai/smithers/packages/backend/modelproxy"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
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

// Repository seats are read as data at successfully activated main, never at
// the current bookmark or a TODO working copy. Missing declarations inherit.
func activatedAgentSeats(ctx context.Context, q *db.Queries, sources workspaceapi.SourceFiles) (map[string]string, error) {
	if sources == nil {
		return nil, nil
	}
	repository, err := q.InstallRepositoryID(ctx)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	row, err := q.GetInstallSetting(ctx, fmt.Sprintf("agent.instructions.main:%d", repository))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var revision string
	if err = json.Unmarshal(row.Value, &revision); err != nil {
		return nil, err
	}
	if revision == "" {
		return nil, nil
	}
	repo, err := q.GetRepoOwnerSlugAndNameByID(ctx, repository)
	if err != nil {
		return nil, err
	}
	raw, err := sources.ReadSourceFile(ctx, workspaceapi.WorkspaceSource{Repository: repo.OwnerSlug + "/" + repo.RepoName, Revision: revision}, ".smithers/coding-project.json")
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(raw) > 256*1024 {
		return nil, errors.New("coding project exceeds read limit")
	}
	var project struct {
		Seats map[string]string `json:"seats"`
	}
	if err = json.Unmarshal(raw, &project); err != nil {
		return nil, err
	}
	for _, seat := range project.Seats {
		if strings.TrimSpace(seat) == "" {
			return nil, errors.New("invalid repository seat")
		}
	}
	return project.Seats, nil
}

func agentProfiles(ctx context.Context, q *db.Queries, sources ...workspaceapi.SourceFiles) (map[string]any, error) {
	var reader workspaceapi.SourceFiles
	if len(sources) > 0 {
		reader = sources[0]
	}
	seats, err := activatedAgentSeats(ctx, q, reader)
	if err != nil {
		return nil, err
	}
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
		if seat, declared := seats[map[string]string{"planner": "coding/plan", "implementer": "coding/implement", "reviewer": "coding/review"}[role]]; declared && role != "app" {
			model.Protocol, model.ModelID, _ = strings.Cut(seat, ":")
			if model.ModelID == "" {
				model.ModelID, model.Protocol = seat, ""
			}
			source, binding = "repository", nil
		}
		modelLabel := model.ModelID
		if model.ModelID == "" {
			model.ModelID = "unconfigured"
		}
		path, _ := services.AgentInstructionsPath(role)
		label := strings.ToUpper(role[:1]) + role[1:] + " agent"
		if role == "app" {
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

func serveAgents(q *db.Queries, sources ...workspaceapi.SourceFiles) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		value, err := agentProfiles(r.Context(), q, sources...)
		if err != nil {
			routes.WriteInstallSetupError(w, r, pkgerrors.Internal("Could not read agents"))
			return
		}
		if name := chi.URLParam(r, "name"); name != "" {
			selected := []map[string]any{}
			for _, profile := range value["agents"].([]map[string]any) {
				if profile["id"] == name {
					selected = append(selected, profile)
				}
			}
			if len(selected) == 0 {
				routes.WriteInstallSetupError(w, r, pkgerrors.NotFound("Agent not found"))
				return
			}
			value["agents"] = selected
		}
		owner, ownerErr := q.GetSelfHostOwner(r.Context())
		info := middleware.AuthInfoFromContext(r.Context())
		value["canAssign"] = ownerErr == nil && middleware.IsOwnerBrowserSession(info, owner.ID)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(value)
	}
}

func assignAgentModel(q *db.Queries, sources ...workspaceapi.SourceFiles) http.HandlerFunc {
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
		serveAgents(q, sources...)(w, r)
	}
}

func resolveFactorySeat(q *db.Queries, sources workspaceapi.SourceFiles) func(context.Context, modelproxy.Caller) (modelproxy.FactorySeat, error) {
	return func(ctx context.Context, caller modelproxy.Caller) (modelproxy.FactorySeat, error) {
		repository, err := q.InstallRepositoryID(ctx)
		if err != nil || repository != caller.RepositoryID {
			return modelproxy.FactorySeat{}, modelproxy.ErrForbidden
		}
		roles := map[string]string{"planner": "coding/plan", "implementer": "coding/implement", "reviewer": "coding/review"}
		role, known := roles[caller.FactoryRole]
		if !known {
			return modelproxy.FactorySeat{}, modelproxy.ErrForbidden
		}
		seats, err := activatedAgentSeats(ctx, q, sources)
		if err != nil {
			return modelproxy.FactorySeat{}, err
		}
		if seat, declared := seats[role]; declared {
			return modelproxy.FactorySeat{Seat: seat}, nil
		}
		raw, err := q.EffectiveInstallAgentModel(ctx, caller.FactoryRole)
		if err != nil {
			return modelproxy.FactorySeat{}, err
		}
		var binding struct {
			Protocol   string `json:"protocol"`
			ModelID    string `json:"modelId"`
			Credential string `json:"credential"`
		}
		if json.Unmarshal(raw, &binding) != nil || binding.ModelID == "" {
			return modelproxy.FactorySeat{}, errors.New("invalid factory model")
		}
		seat, known := modelproxy.SeatFor(binding.Credential)
		if !known {
			return modelproxy.FactorySeat{}, errors.New("factory key is not offered")
		}
		return modelproxy.FactorySeat{Seat: seat.Provider + ":" + binding.ModelID, Protocol: binding.Protocol}, nil
	}
}

// Snapshot committed delivery intents before the guest drains its existing queue.
// The worker remains the sole delivery/authorization path; this read-only fence
// neither renders input nor acknowledges it on the worker's behalf.
func fenceTodoInputs(pool *pgxpool.Pool) func(context.Context, modelproxy.Caller, string) error {
	return func(ctx context.Context, caller modelproxy.Caller, run string) error {
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		var bound bool
		if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM mythical_items WHERE repository_id=$1 AND workspace_id=$2 AND request_run_id=$3 AND source='todo' AND state NOT IN ('landed','cancelled','rejected','declined'))`, caller.RepositoryID, caller.WorkspaceID, run).Scan(&bound); err != nil {
			return err
		}
		if !bound || run == "" {
			return modelproxy.ErrForbidden
		}
		rows, err := pool.Query(ctx, `SELECT id::text FROM product_job_requests WHERE tenant_id=$1 AND payload->>'runId'=$2 AND operation IN ('flow.runtime.steer','flow.runtime.signal') AND state NOT IN ('completed','failed','cancelled','uncertain')`, fmt.Sprintf("repository:%d", caller.RepositoryID), run)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		timer := time.NewTicker(25 * time.Millisecond)
		defer timer.Stop()
		for {
			var pending, refused int
			if err := pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE state NOT IN ('completed','failed','cancelled','uncertain')), count(*) FILTER (WHERE state IN ('failed','cancelled','uncertain')) FROM product_job_requests WHERE id::text=ANY($1)`, ids).Scan(&pending, &refused); err != nil {
				return err
			}
			if refused > 0 {
				return errors.New("TODO input delivery refused")
			}
			if pending == 0 {
				return nil
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-timer.C:
			}
		}
	}
}
