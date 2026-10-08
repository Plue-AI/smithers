package routes

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type installDispatchRequestKey struct{}

// PrepareInstallWorkflowDispatch validates the body command before feature
// gates or workflow lookup can obscure its authorization. The handler consumes
// this same decoded input and binds flow.run only after subject resolution.
func PrepareInstallWorkflowDispatch(w http.ResponseWriter, r *http.Request, queries *db.Queries) bool {
	if _, ok := r.Context().Value(installDispatchRequestKey{}).(dispatchWorkflowRequest); ok {
		return true
	}
	var input dispatchWorkflowRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, &input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return false
	}
	// A workflow door cannot execute another catalog command, including a
	// hidden system operation, under an allowed workflow name.
	if input.Command != "" && input.Command != "flow.run" {
		_, err := services.Authorize(r.Context(), queries, "denied")
		writeRouteError(w, r, err)
		return false
	}
	*r = *r.WithContext(context.WithValue(r.Context(), installDispatchRequestKey{}, input))
	return true
}

func (h *WorkflowHandler) decodeDispatch(w http.ResponseWriter, r *http.Request, input *dispatchWorkflowRequest) bool {
	if h.InstallQueries == nil {
		return decodeJSONBody(w, r, input)
	}
	if !PrepareInstallWorkflowDispatch(w, r, h.InstallQueries) {
		return false
	}
	*input = r.Context().Value(installDispatchRequestKey{}).(dispatchWorkflowRequest)
	return true
}

func (h *WorkflowHandler) authorizeDispatch(w http.ResponseWriter, r *http.Request, definition db.WorkflowDefinition, ref string, inputs map[string]interface{}) bool {
	if h.InstallQueries == nil {
		return true
	}
	canonical, err := json.Marshal(struct {
		Definition int64
		Ref        string
		Inputs     map[string]interface{}
	}{definition.ID, ref, inputs})
	if err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return false
	}
	digest := sha256.Sum256(canonical)
	subject := services.InstallSubject{RepositoryID: definition.RepositoryID, Resource: fmt.Sprintf("workflows/%d", definition.ID), Source: ref, PayloadDigest: hex.EncodeToString(digest[:])}
	decision, err := services.Authorize(r.Context(), h.InstallQueries, "flow.run", subject)
	if err != nil {
		writeRouteError(w, r, err)
		return false
	}
	*r = *r.WithContext(services.WithInstallAuthorization(r.Context(), "flow.run", decision, subject))
	return true
}
