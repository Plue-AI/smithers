package compose

import (
	"bytes"
	"encoding/json"
	stdErrors "errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// memberCommands binds one install command decision before the handler runs.
// Owners use the same authorizer as every other member. A handler resolving
// the same command reuses the decision; a different command is checked anew.
func memberCommands(queries *db.Queries, confirmations ...*services.ApprovalsService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := middleware.AuthInfoFromContext(r.Context())
			command := middleware.InstallMemberCommand(r.Method, r.URL.EscapedPath())
			if info == nil || info.User == nil || command == "" || command == "self" {
				next.ServeHTTP(w, r)
				return
			}
			// AuthLoader has already confined this issuer-owned credential to its
			// exact file PUT body. The workspace service rechecks membership,
			// write authority and the live token/host fence through the mutation.
			// It does not authorize the generic branch-join command.
			if binding, ok := middleware.CodingFileCredential(info); ok && command == "branch.join" && middleware.CodingFileBatchVerified(info, binding.BatchDigest) {
				next.ServeHTTP(w, r)
				return
			}
			if command == "todo.new" {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
				if err != nil {
					writeConfirmationDispatchError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_todo", Message: "Invalid TODO request"})
					return
				}
				var input struct {
					Issue *int64 `json:"issue"`
				}
				if err := json.Unmarshal(raw, &input); err != nil {
					writeConfirmationDispatchError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_todo", Message: "Invalid TODO request"})
					return
				}
				if input.Issue != nil {
					command = "todo.from-issue"
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
			}
			if command == "todo.control" {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
				if err != nil {
					writeConfirmationDispatchError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_control", Message: "Invalid TODO control"})
					return
				}
				_, resolved, err := routes.DecodeTodoControl(bytes.NewReader(raw))
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				command = resolved
				r.Body = io.NopCloser(bytes.NewReader(raw))
			}
			// Resolve the existing command body once, before its sole authority
			// decision. Only a configured approval service owns confirmation.
			delegation, delegated := info.Delegation()
			if len(confirmations) > 0 && confirmations[0] != nil && delegated && delegation.Profile == "" && delegation.Branch == "" && info.CredentialKind() == middleware.CredentialDelegated {
				if handled := dispatchConfirmation(w, r, command, confirmations[0]); handled {
					return
				}
			}
			decision, err := services.Authorize(r.Context(), queries, command)
			if err != nil {
				var access *services.AccessError
				if !stdErrors.As(err, &access) {
					pkgerrors.WriteError(w, pkgerrors.Internal("failed to authorize member").WithCause(err))
					return
				}
				// The restricted S1 profile can request append confirmation
				// only. Before never reaches a confirmation consumer.
				if _, terminal := info.TerminalDelegation(); terminal && command == "todo.new" && access.Code == "confirm_in_app" {
					var input struct {
						Place struct {
							Mode string `json:"mode"`
						} `json:"place"`
					}
					if json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&input) == nil && input.Place.Mode == "before" {
						access = &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "A terminal's credential cannot do this"}
					}
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(access.Status)
				_ = json.NewEncoder(w).Encode(access)
				return
			}
			next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision)))
		})
	}
}

// dispatchConfirmation adapts only HTTP subjects; ApprovalsService and the
// catalog own authority, availability, snapshots and atomic action execution.
func dispatchConfirmation(w http.ResponseWriter, r *http.Request, command string, service *services.ApprovalsService) bool {
	policy, known := services.OperationPolicy(command)
	if command != "todo.control" && (!known || policy.Agent != "confirm") {
		return false
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10))
	if err != nil {
		writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid confirmation request"})
		return true
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if command == "todo.control" {
		_, resolved, decodeErr := routes.DecodeTodoControl(bytes.NewReader(raw))
		if decodeErr != nil {
			writeConfirmationDispatchError(w, decodeErr)
			return true
		}
		command = resolved
		policy, known = services.OperationPolicy(command)
		if !known || policy.Agent != "confirm" {
			return false
		}
	}
	input := services.ConfirmationInput{Command: command, Payload: raw, Key: r.Header.Get("Idempotency-Key")}
	if strings.HasPrefix(r.URL.Path, "/api/todos/") {
		part := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/todos/"), "/")[0]
		n, err := strconv.ParseInt(part, 10, 64)
		if err != nil || n <= 0 {
			writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_todo", Message: "Invalid TODO number"})
			return true
		}
		input.Subject, _ = json.Marshal(map[string]string{"kind": "todo", "ref": "T" + strconv.FormatInt(n, 10)})
	}
	receipt, err := service.RequestConfirmation(r.Context(), input)
	if err != nil {
		writeConfirmationDispatchError(w, err)
		return true
	}
	routes.WriteRequestedConfirmation(w, r, receipt)
	return true
}
func writeConfirmationDispatchError(w http.ResponseWriter, err error) {
	var access *services.AccessError
	var control *services.TodoControlError
	w.Header().Set("Content-Type", "application/json")
	switch {
	case stdErrors.As(err, &access):
		w.WriteHeader(access.Status)
		_ = json.NewEncoder(w).Encode(access)
	case stdErrors.As(err, &control):
		w.WriteHeader(control.Status)
		_ = json.NewEncoder(w).Encode(control)
	default:
		pkgerrors.WriteError(w, pkgerrors.Internal("Confirmation unavailable").WithCause(err))
	}
}
