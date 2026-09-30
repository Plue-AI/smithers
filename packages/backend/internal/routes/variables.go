package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type VariableRouteService interface {
	SetVariable(ctx context.Context, actor *db.User, owner, repo, name, value string) (services.VariableResponse, error)
	GetVariable(ctx context.Context, actor *db.User, owner, repo, name string) (services.VariableResponse, error)
	ListVariables(ctx context.Context, actor *db.User, owner, repo string) ([]services.VariableResponse, error)
	DeleteVariable(ctx context.Context, actor *db.User, owner, repo, name string) error
	SetOrgVariable(ctx context.Context, actor *db.User, orgName, name, value string) (services.VariableResponse, error)
	ListOrgVariables(ctx context.Context, actor *db.User, orgName string) ([]services.VariableResponse, error)
	DeleteOrgVariable(ctx context.Context, actor *db.User, orgName, name string) error
}

type VariableHandler struct {
	Service VariableRouteService
	Metrics *SmithersMetrics
}

type setVariableRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func (h *VariableHandler) ListVariables(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	variables, err := h.Service.ListVariables(r.Context(), actor, owner, repo)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, variables)
}

func (h *VariableHandler) GetVariable(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	name, err := routeParam(r, "name", "variable name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	variable, err := h.Service.GetVariable(r.Context(), actor, owner, repo, name)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, variable)
}

func (h *VariableHandler) SetVariable(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req setVariableRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if apiErr := validateSecretVariableName(req.Name, "Variable"); apiErr != nil {
		h.Metrics.IncValidationRejection("Variable", "name")
		errors.WriteError(w, apiErr)
		return
	}
	if apiErr := validateSecretVariableValue(req.Value, "Variable"); apiErr != nil {
		h.Metrics.IncValidationRejection("Variable", "value")
		errors.WriteError(w, apiErr)
		return
	}

	variable, err := h.Service.SetVariable(r.Context(), actor, owner, repo, req.Name, req.Value)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, variable)
}

func (h *VariableHandler) DeleteVariable(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	name, err := routeParam(r, "name", "variable name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if apiErr := validateSecretVariableName(name, "Variable"); apiErr != nil {
		h.Metrics.IncValidationRejection("Variable", "name")
		errors.WriteError(w, apiErr)
		return
	}

	if err := h.Service.DeleteVariable(r.Context(), actor, owner, repo, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *VariableHandler) ListOrgVariables(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	variables, err := h.Service.ListOrgVariables(r.Context(), actor, orgName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, variables)
}

func (h *VariableHandler) SetOrgVariable(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	var req setVariableRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if apiErr := validateSecretVariableName(req.Name, "Variable"); apiErr != nil {
		h.Metrics.IncValidationRejection("Variable", "name")
		errors.WriteError(w, apiErr)
		return
	}
	if apiErr := validateSecretVariableValue(req.Value, "Variable"); apiErr != nil {
		h.Metrics.IncValidationRejection("Variable", "value")
		errors.WriteError(w, apiErr)
		return
	}

	variable, err := h.Service.SetOrgVariable(r.Context(), actor, orgName, req.Name, req.Value)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, variable)
}

func (h *VariableHandler) DeleteOrgVariable(w http.ResponseWriter, r *http.Request) {
	actor, err := requireRouteUser(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	name, err := routeParam(r, "name", "variable name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if apiErr := validateSecretVariableName(name, "Variable"); apiErr != nil {
		h.Metrics.IncValidationRejection("Variable", "name")
		errors.WriteError(w, apiErr)
		return
	}
	if err := h.Service.DeleteOrgVariable(r.Context(), actor, orgName, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
