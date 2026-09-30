package routes

import (
	"context"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type SecretRouteService interface {
	SetSecret(ctx context.Context, actor *db.User, owner, repo, name, value string, mainOnly *bool, binding *services.SecretBinding) (services.SecretResponse, error)
	SetSecretMainOnly(ctx context.Context, actor *db.User, owner, repo, name string, mainOnly bool) (services.SecretResponse, error)
	SetSecretBinding(ctx context.Context, actor *db.User, owner, repo, name string, binding services.SecretBinding) (services.SecretResponse, error)
	ListSecrets(ctx context.Context, actor *db.User, owner, repo string) ([]services.SecretResponse, error)
	DeleteSecret(ctx context.Context, actor *db.User, owner, repo, name string) error
	SetOrgSecret(ctx context.Context, actor *db.User, orgName, name, value string, binding *services.SecretBinding) (services.SecretResponse, error)
	ListOrgSecrets(ctx context.Context, actor *db.User, orgName string) ([]services.SecretResponse, error)
	DeleteOrgSecret(ctx context.Context, actor *db.User, orgName, name string) error
}

type SecretHandler struct {
	Service          SecretRouteService
	AgentEnvironment AgentEnvironmentRouteService
	Metrics          *SmithersMetrics
}

type setSecretRequest struct {
	Name  string `json:"name"`
	Value string `json:"value"`
	// MainOnly limits the secret to trusted runs on the default bookmark;
	// omitted keeps a replaced secret's scope.
	MainOnly *bool `json:"main_only"`
	secretBindingRequest
}

// secretBindingRequest is a write's optional egress binding: the hosts and
// request headers the secret may be sent to. Omitted keeps a replaced
// secret's binding; empty lists on both sides unbind it.
type secretBindingRequest struct {
	Hosts        *[]string `json:"hosts"`
	MatchHeaders *[]string `json:"match_headers"`
}

func (b secretBindingRequest) binding() *services.SecretBinding {
	if b.Hosts == nil && b.MatchHeaders == nil {
		return nil
	}
	binding := services.SecretBinding{}
	if b.Hosts != nil {
		binding.Hosts = *b.Hosts
	}
	if b.MatchHeaders != nil {
		binding.MatchHeaders = *b.MatchHeaders
	}
	return &binding
}

type setSecretScopeRequest struct {
	MainOnly *bool `json:"main_only"`
	secretBindingRequest
}

func (h *SecretHandler) ListSecrets(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	secrets, err := h.Service.ListSecrets(r.Context(), actor, owner, repo)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, secrets)
}

func (h *SecretHandler) SetSecret(w http.ResponseWriter, r *http.Request) {
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

	var req setSecretRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if apiErr := validateSecretVariableName(req.Name, "Secret"); apiErr != nil {
		h.Metrics.IncValidationRejection("Secret", "name")
		errors.WriteError(w, apiErr)
		return
	}
	if apiErr := validateSecretVariableValue(req.Value, "Secret"); apiErr != nil {
		h.Metrics.IncValidationRejection("Secret", "value")
		errors.WriteError(w, apiErr)
		return
	}

	secret, err := h.Service.SetSecret(r.Context(), actor, owner, repo, req.Name, req.Value, req.MainOnly, req.binding())
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, secret)
}

// SetSecretScope marks a repository secret main-only, or clears the mark,
// and sets or clears its egress binding, without its value.
func (h *SecretHandler) SetSecretScope(w http.ResponseWriter, r *http.Request) {
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
	name, err := routeParam(r, "name", "secret name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if apiErr := validateSecretVariableName(name, "Secret"); apiErr != nil {
		h.Metrics.IncValidationRejection("Secret", "name")
		errors.WriteError(w, apiErr)
		return
	}
	var req setSecretScopeRequest
	if !decodeJSONBodyWithMessage(w, r, &req, "main_only or a binding is required") {
		return
	}
	binding := req.binding()
	if req.MainOnly == nil && binding == nil {
		errors.WriteError(w, errors.BadRequest("main_only or a binding is required"))
		return
	}
	var secret services.SecretResponse
	if binding != nil {
		if secret, err = h.Service.SetSecretBinding(r.Context(), actor, owner, repo, name, *binding); err != nil {
			writeRouteError(w, r, err)
			return
		}
	}
	if req.MainOnly != nil {
		if secret, err = h.Service.SetSecretMainOnly(r.Context(), actor, owner, repo, name, *req.MainOnly); err != nil {
			writeRouteError(w, r, err)
			return
		}
	}
	errors.WriteJSON(w, http.StatusOK, secret)
}

func (h *SecretHandler) DeleteSecret(w http.ResponseWriter, r *http.Request) {
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
	name, err := routeParam(r, "name", "secret name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}

	if apiErr := validateSecretVariableName(name, "Secret"); apiErr != nil {
		h.Metrics.IncValidationRejection("Secret", "name")
		errors.WriteError(w, apiErr)
		return
	}

	if err := h.Service.DeleteSecret(r.Context(), actor, owner, repo, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *SecretHandler) ListOrgSecrets(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	orgName, err := routeParam(r, "org", "organization name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	secrets, err := h.Service.ListOrgSecrets(r.Context(), actor, orgName)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, secrets)
}

func (h *SecretHandler) SetOrgSecret(w http.ResponseWriter, r *http.Request) {
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

	var req setSecretRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}
	if apiErr := validateSecretVariableName(req.Name, "Secret"); apiErr != nil {
		h.Metrics.IncValidationRejection("Secret", "name")
		errors.WriteError(w, apiErr)
		return
	}
	if apiErr := validateSecretVariableValue(req.Value, "Secret"); apiErr != nil {
		h.Metrics.IncValidationRejection("Secret", "value")
		errors.WriteError(w, apiErr)
		return
	}

	secret, err := h.Service.SetOrgSecret(r.Context(), actor, orgName, req.Name, req.Value, req.binding())
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, secret)
}

func (h *SecretHandler) DeleteOrgSecret(w http.ResponseWriter, r *http.Request) {
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
	name, err := routeParam(r, "name", "secret name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if apiErr := validateSecretVariableName(name, "Secret"); apiErr != nil {
		h.Metrics.IncValidationRejection("Secret", "name")
		errors.WriteError(w, apiErr)
		return
	}
	if err := h.Service.DeleteOrgSecret(r.Context(), actor, orgName, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
