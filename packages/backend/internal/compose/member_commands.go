package compose

import (
	"bytes"
	"encoding/json"
	stdErrors "errors"
	"io"
	"net/http"
	"net/url"
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
			if r.Method == http.MethodPost && strings.HasPrefix(r.URL.EscapedPath(), "/api/branches/") && !strings.Contains(strings.TrimPrefix(r.URL.EscapedPath(), "/api/branches/"), "/") {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
				var body struct {
					Op       string `json:"op"`
					ID       string `json:"id"`
					Revision string `json:"revision"`
				}
				decoder := json.NewDecoder(bytes.NewReader(raw))
				decoder.DisallowUnknownFields()
				if err != nil || decoder.Decode(&body) != nil || body.Op != "bring-in" && body.Op != "discard-foreign" {
					writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid branch answer"})
					return
				}
				command = "branch." + body.Op
				r.Body = io.NopCloser(bytes.NewReader(raw))
			}

			if command == "repo.read" && services.InstallExecutionCredential(r.Context()) {
				parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
				if len(parts) == 5 && parts[1] == "repos" && parts[4] == "mythical" {
					repository, err := queries.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(parts[2]), LowerName: strings.ToLower(parts[3])})
					if err != nil {
						writeConfirmationDispatchError(w, &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"})
						return
					}
					subject, err := services.ResolveInstallExecutionSubject(r.Context(), queries, repository.ID)
					if err != nil {
						writeConfirmationDispatchError(w, err)
						return
					}
					decision, err := services.Authorize(r.Context(), queries, command, subject)
					if err != nil {
						writeConfirmationDispatchError(w, err)
						return
					}
					next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
					return
				}
			}
			if command == "stack.candidate" {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
				var input services.MythicalLaneSubmission
				if err != nil || json.Unmarshal(raw, &input) != nil {
					writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_candidate", Message: "Invalid candidate"})
					return
				}
				repository, err := services.InstallRepositoryID(r.Context(), queries)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
				row, err := queries.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(parts[2]), LowerName: strings.ToLower(parts[3])})
				if err != nil || row.ID != repository {
					writeConfirmationDispatchError(w, &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"})
					return
				}
				subject, err := services.ResolveInstallCandidateSubject(r.Context(), queries, repository, input)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				decision, err := services.Authorize(r.Context(), queries, command, subject)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
				next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
				return
			}
			if command == "todo.read" && services.InstallExecutionCredential(r.Context()) {
				parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
				subject := services.InstallSubject{}
				if len(parts) == 3 && parts[1] == "todos" {
					subject.TodoNumber, _ = strconv.ParseInt(parts[2], 10, 64)
					var err error
					subject.RepositoryID, err = services.InstallRepositoryID(r.Context(), queries)
					if err != nil {
						writeConfirmationDispatchError(w, err)
						return
					}
				}
				decision, err := services.Authorize(r.Context(), queries, command, subject)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
				return
			}
			if command == "workspace.head" || strings.HasPrefix(command, "workspace.children.") {
				subject := services.InstallSubject{}
				if repo := middleware.RepoFromContext(r.Context()); repo != nil {
					subject.RepositoryID = repo.ID
				}
				parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
				if len(parts) == 7 || len(parts) == 9 {
					subject.WorkspaceID = parts[5]
					if len(parts) == 9 {
						subject.ChildWorkspaceID = parts[7]
					}
					if subject.RepositoryID == 0 && queries != nil {
						repo, err := queries.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(parts[2]), LowerName: strings.ToLower(parts[3])})
						if err == nil {
							subject.RepositoryID = repo.ID
						}
					}
				}
				decision, err := services.Authorize(r.Context(), queries, command, subject)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
				return
			}
			if info != nil && info.User != nil && info.IsTokenAuth && command == "" {
				// AuthLoader already confines these system grants to their exact
				// workspace/child or verified coding batch before dispatch.
				_, coding := middleware.CodingFileCredential(info)
				scopedSystem := info.TokenSystemIssued && (info.CredentialKind() == middleware.CredentialMachine && info.WorkspaceRestriction() != "" || middleware.ParseTokenWorkspaceChildrenCredential(info.RawScopes) || coding)

				if !scopedSystem {
					writeConfirmationDispatchError(w, &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"})
					return
				}
			}
			if info == nil || info.User == nil || command == "" || command == "self" || command == "public" {
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
			if command == "approval.decide" {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
				var input struct {
					Decision string `json:"decision"`
				}
				decoder := json.NewDecoder(bytes.NewReader(raw))
				decoder.DisallowUnknownFields()
				if err != nil || decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || (input.Decision != services.ApprovalStateApproved && input.Decision != services.ApprovalStateRejected) {
					writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_approval", Message: "Invalid approval decision"})
					return
				}
				command = "approval.approve"
				if input.Decision == services.ApprovalStateRejected {
					command = "approval.deny"
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
			}
			if command == "file.restore" {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
				if err != nil {
					pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid restore request"))
					return
				}
				_, resolved, err := routes.DecodeFileRestore(bytes.NewReader(raw))
				if err != nil {
					var apiError *pkgerrors.APIError
					if stdErrors.As(err, &apiError) {
						pkgerrors.WriteError(w, apiError)
					} else {
						pkgerrors.WriteError(w, pkgerrors.BadRequest("invalid restore request"))
					}
					return
				}
				command = resolved
				r.Body = io.NopCloser(bytes.NewReader(raw))
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
			// Branch-bound terminal credentials retain their confirmation refusal until
			// a qualified private card handoff is composed for that session.
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
	if command == "branch.add-to-stack" {
		part := strings.TrimSuffix(strings.TrimPrefix(r.URL.EscapedPath(), "/api/branches/"), "/add-to-stack")
		branch, err := url.PathUnescape(part)
		if err != nil || branch == "" {
			writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid branch"})
			return true
		}
		input.Subject, _ = json.Marshal(map[string]string{"kind": "branch", "ref": branch})
	}
	if command == "branch.discard-foreign" || command == "branch.bring-in" {
		input.Subject, _ = json.Marshal(map[string]string{"kind": "branch", "ref": strings.TrimPrefix(r.URL.Path, "/api/branches/")})
		var body map[string]json.RawMessage
		if json.Unmarshal(raw, &body) == nil {
			delete(body, "op")
			input.Payload, _ = json.Marshal(body)
		}
	}
	if command == "learning.accept" || command == "learning.dismiss" {
		part := strings.TrimPrefix(r.URL.EscapedPath(), "/api/proposals/")
		ref, _, ok := strings.Cut(part, "/")
		if !ok || ref == "" {
			writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid proposal"})
			return true
		}
		decoded, decodeErr := url.PathUnescape(ref)
		if decodeErr != nil {
			writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid proposal"})
			return true
		}
		input.Subject, _ = json.Marshal(map[string]string{"kind": "proposal", "ref": decoded})
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
