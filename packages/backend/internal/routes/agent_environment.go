package routes

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type AgentEnvironmentRouteService interface {
	GetAgentEnvironment(ctx context.Context, actor *db.User, owner, repo string) (services.AgentEnvironmentResponse, error)
	PutAgentEnvironment(ctx context.Context, actor *db.User, owner, repo string, input services.PutAgentEnvironmentInput) (services.AgentEnvironmentResponse, error)
	PutAgentEnvironmentSecret(ctx context.Context, actor *db.User, owner, repo string, input services.AgentEnvironmentSecretWrite) (services.AgentEnvironmentSecretMetadata, error)
	DeleteAgentEnvironmentSecret(ctx context.Context, actor *db.User, owner, repo, name string) error
}

func (h *SecretHandler) GetAgentEnvironment(w http.ResponseWriter, r *http.Request) {
	actor := middleware.UserFromContext(r.Context())
	owner, repo, err := repoOwnerAndName(r)
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	config, err := h.AgentEnvironment.GetAgentEnvironment(r.Context(), actor, owner, repo)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, config)
}

func (h *SecretHandler) PutAgentEnvironment(w http.ResponseWriter, r *http.Request) {
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
	var input services.PutAgentEnvironmentInput
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSONDecodeError(w, "invalid request body", err)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			errors.WriteError(w, errors.BadRequest("invalid request body"))
		} else {
			writeJSONDecodeError(w, "invalid request body", err)
		}
		return
	}
	config, err := h.AgentEnvironment.PutAgentEnvironment(r.Context(), actor, owner, repo, input)
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusOK, config)
}

// putAgentEnvironmentSecretRequest is the write shape. hosts + match_headers
// bind the secret to the egress proxy; omit both for the legacy path.
type putAgentEnvironmentSecretRequest struct {
	Value        string   `json:"value"`
	Hosts        []string `json:"hosts,omitempty"`
	MatchHeaders []string `json:"match_headers,omitempty"`
}

func (h *SecretHandler) PutAgentEnvironmentSecret(w http.ResponseWriter, r *http.Request) {
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
	name, err := routeParam(r, "name", "agent environment secret name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	var input putAgentEnvironmentSecretRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, middleware.MaxRequestBodySize))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		errors.WriteError(w, errors.BadRequest("invalid request body"))
		return
	}
	secret, err := h.AgentEnvironment.PutAgentEnvironmentSecret(r.Context(), actor, owner, repo, services.AgentEnvironmentSecretWrite{
		Name: name, Value: input.Value, Hosts: input.Hosts, MatchHeaders: input.MatchHeaders,
	})
	if err != nil {
		writeRouteError(w, r, err)
		return
	}
	errors.WriteJSON(w, http.StatusCreated, secret)
}

func (h *SecretHandler) DeleteAgentEnvironmentSecret(w http.ResponseWriter, r *http.Request) {
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
	name, err := routeParam(r, "name", "agent environment secret name is required")
	if err != nil {
		errors.WriteError(w, err.(*errors.APIError))
		return
	}
	if err := h.AgentEnvironment.DeleteAgentEnvironmentSecret(r.Context(), actor, owner, repo, name); err != nil {
		writeRouteError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
