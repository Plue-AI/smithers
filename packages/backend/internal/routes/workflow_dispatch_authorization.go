package routes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func (h *WorkflowHandler) decodeDispatch(w http.ResponseWriter, r *http.Request, input *dispatchWorkflowRequest) bool {
	if h.InstallQueries == nil {
		return decodeJSONBody(w, r, input)
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	decoder.DisallowUnknownFields()
	if err := decodeSingleJSONDocument(decoder, input); err != nil {
		pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid request body"))
		return false
	}
	// This door dispatches a workflow; it cannot execute a different catalog
	// command just because the caller supplied an allowed workflow name.
	if input.Command != "" && input.Command != "flow.run" {
		_, err := services.Authorize(r.Context(), h.InstallQueries, "denied")
		writeRouteError(w, r, err)
		return false
	}
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
