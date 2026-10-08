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

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// memberCommands binds one install command decision before the handler runs.
// Owners use the same authorizer as every other member. A handler resolving
// the same command reuses the decision; substituting a command is refused.
func memberCommands(queries *db.Queries, confirmations ...*services.ApprovalsService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			info := middleware.AuthInfoFromContext(r.Context())
			command := middleware.InstallMemberCommand(r.Method, r.URL.EscapedPath())
			if command == "github.import-read" {
				subject, validation := services.InstallGitHubImportReadSubject(strings.TrimPrefix(r.URL.Path, "/api/github/import/"))
				decision, err := services.Authorize(r.Context(), queries, command, subject)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				if validation != nil {
					writeConfirmationDispatchError(w, validation)
					return
				}
				next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
				return
			}
			if command == "background.retry" && r.Method == http.MethodPost {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
				if err != nil {
					writeConfirmationDispatchError(w, &services.TodoControlError{Status: 400, Class: "user", Code: "invalid_run_action", Message: "Invalid run action"})
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
				var input struct {
					Op string `json:"op"`
				}
				if json.Unmarshal(raw, &input) == nil && input.Op == "dismiss" {
					command = "background.dismiss"
				}
			}
			if r.Method == http.MethodPut && r.URL.Path == "/api/install" {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 16<<10))
				if err != nil {
					writeConfirmationDispatchError(w, pkgerrors.BadRequest("invalid setup body"))
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
			}
			if command == "order.ok" {
				var ok bool
				command, ok = routes.StackAttentionCommand(w, r)
				if !ok {
					return
				}
			}
			if r.Method == http.MethodPost && strings.HasPrefix(r.URL.EscapedPath(), "/api/branches/") && !strings.Contains(strings.TrimPrefix(r.URL.EscapedPath(), "/api/branches/"), "/") {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
				if err != nil {
					routes.WriteBranchCommandError(w, r, pkgerrors.BadRequest("Invalid branch answer"))
					return
				}
				_, resolved, err := routes.DecodeBranchCommand(bytes.NewReader(raw))
				if err != nil {
					routes.WriteBranchCommandError(w, r, err)
					return
				}
				command = resolved
				r.Body = io.NopCloser(bytes.NewReader(raw))
			}

			if command == "account.oauth.revoke" || command == "account.profile.update" || command == "account.notifications.update" || command == "account.connection.delete" || command == "account.signup.update" || command == "account.device.register" || command == "account.device.delete" || command == "account.email.add" || command == "account.email.delete" || command == "account.email.verify" || command == "account.inbox.read" || command == "account.inbox.read-all" || command == "account.inbox.preferences" {
				admitInstallAccountMutation(w, r, queries, command, next)
				return
			}
			if command == "egress.read" || command == "egress.update" || strings.HasPrefix(command, "webhooks.") || command == "repo.topics.update" || strings.HasPrefix(command, "labels.") || strings.HasPrefix(command, "protected-bookmarks.") || strings.HasPrefix(command, "variables.") || strings.HasPrefix(command, "deploy-keys.") {
				admitInstallRepositoryAdmin(w, r, queries, command, next)
				return
			}
			if command == "branch.archive" {
				delegation, delegated := info.Delegation()
				if len(confirmations) > 0 && confirmations[0] != nil && delegated && delegation.Profile == "" && delegation.Branch == "" && info.CredentialKind() == middleware.CredentialDelegated {
					if dispatchConfirmation(w, r, command, confirmations[0]) {
						return
					}
				}
				repository, err := services.InstallRepositoryID(r.Context(), queries)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				selector, err := url.PathUnescape(strings.TrimSuffix(strings.TrimPrefix(r.URL.EscapedPath(), "/api/branches/"), "/archive"))
				if err != nil {
					writeConfirmationDispatchError(w, pkgerrors.BadRequest("invalid branch"))
					return
				}
				subject, _, lookup := services.InstallScratchArchiveSubject(r.Context(), queries, repository, selector)
				decision, err := services.Authorize(r.Context(), queries, command, subject)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				if lookup != nil {
					writeConfirmationDispatchError(w, lookup)
					return
				}
				next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
				return
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
			if command == "branch.fork" && services.InstallExecutionCredential(r.Context()) {
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
				if err != nil {
					writeConfirmationDispatchError(w, pkgerrors.BadRequest("Invalid fork request"))
					return
				}
				input, err := routes.DecodeBranchFork(bytes.NewReader(raw))
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				repository, err := services.InstallRepositoryID(r.Context(), queries)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				subject := services.InstallBranchForkSubject(r.Context(), repository, input)
				decision, err := services.Authorize(r.Context(), queries, command, subject)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
				next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
				return
			}
			if (command == "stack.candidate" || command == "stack.propose") && strings.Contains(r.URL.Path, "/stack/") {
				repository, err := services.InstallRepositoryID(r.Context(), queries)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
				subject := services.InstallSubject{RepositoryID: repository}
				if len(parts) == 8 {
					row, lookup := queries.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(parts[2]), LowerName: strings.ToLower(parts[3])})
					if lookup == nil && row.ID == repository {
						subject, err = services.ResolveReservedStackSubject(r.Context(), queries, repository, parts[5])
					} else {
						err = &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"}
					}
				}
				if err != nil {
					if _, denied := services.Authorize(r.Context(), queries, command, services.InstallSubject{RepositoryID: repository}); denied != nil {
						err = denied
					}
					writeConfirmationDispatchError(w, err)
					return
				}
				raw, decodeErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 65536))
				var input services.ReservedStackInput
				decoder := json.NewDecoder(bytes.NewReader(raw))
				decoder.DisallowUnknownFields()
				if decodeErr != nil || decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
					decodeErr = pkgerrors.BadRequest("invalid stack operation")
				} else {
					var bound services.InstallSubject
					bound, decodeErr = services.BindReservedStackPayload(subject, command, input)
					if decodeErr == nil {
						subject = bound
					}
				}
				if decodeErr != nil {
					// Invalid input has no effect. Keep credential refusal
					// priority for excluded/stale execution principals.
					if _, denied := services.Authorize(r.Context(), queries, command, subject); denied != nil {
						decodeErr = denied
					}
					writeConfirmationDispatchError(w, decodeErr)
					return
				}
				r.Body = io.NopCloser(bytes.NewReader(raw))
				decision, err := services.Authorize(r.Context(), queries, command, subject)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
				return
			}
			if command == "stack.candidate" {
				repository, err := services.InstallRepositoryID(r.Context(), queries)
				if err != nil {
					writeConfirmationDispatchError(w, err)
					return
				}
				// Resolve the existing execution binding before reading a candidate.
				// Scope-shaped, unbound credentials have no system-write authority.
				if _, err := services.ResolveInstallExecutionSubject(r.Context(), queries, repository); err != nil {
					if denied, ok := err.(*services.AccessError); ok && denied.Status == http.StatusForbidden {
						// Keep the refusal on the same command authorizer as a
						// bound submission, without reading its payload.
						if _, denied := services.Authorize(r.Context(), queries, command, services.InstallSubject{RepositoryID: repository}); denied != nil {
							err = denied
						}
					}
					writeConfirmationDispatchError(w, err)
					return
				}
				raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2<<20))
				var input services.MythicalLaneSubmission
				if err != nil || json.Unmarshal(raw, &input) != nil {
					writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_candidate", Message: "Invalid candidate"})
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
			if command == "branch.read" && strings.HasSuffix(r.URL.Path, "/visibility") {
				parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
				if len(parts) == 9 && parts[4] == "workspaces" && parts[6] == "services" {
					repository, lookup := queries.GetRepoByOwnerAndLowerName(r.Context(), db.GetRepoByOwnerAndLowerNameParams{Owner: strings.ToLower(parts[2]), LowerName: strings.ToLower(parts[3])})
					port, parse := strconv.ParseUint(parts[7], 10, 16)
					subject := services.InstallWorkspaceVisibilitySubject(repository.ID, parts[5], uint16(port))
					decision, err := services.Authorize(r.Context(), queries, command, subject)
					if err != nil {
						writeConfirmationDispatchError(w, err)
						return
					}
					if lookup != nil {
						if stdErrors.Is(lookup, pgx.ErrNoRows) {
							writeConfirmationDispatchError(w, pkgerrors.NotFound("repository not found"))
						} else {
							writeConfirmationDispatchError(w, pkgerrors.Internal("load preview repository").WithCause(lookup))
						}
						return
					}
					if parse != nil || port == 0 {
						writeConfirmationDispatchError(w, pkgerrors.BadRequest("invalid preview"))
						return
					}
					next.ServeHTTP(w, r.WithContext(services.WithInstallAuthorization(r.Context(), command, decision, subject)))
					return
				}
			}
			if command == "branch.read" && services.InstallExecutionCredential(r.Context()) {
				subject, err := routes.InstallBranchReadSubject(r, queries)
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
			if command == "wiki.read" && services.InstallExecutionCredential(r.Context()) {
				admitInstallExecutionWikiRead(w, r, queries, next)
				return
			}
			if command == "todo.read" && services.InstallExecutionCredential(r.Context()) {
				parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
				subject := services.InstallSubject{}
				if (len(parts) == 3 || len(parts) == 7 && parts[3] == "attempts" && parts[5] == "logs") && parts[1] == "todos" {
					subject.TodoNumber, _ = strconv.ParseInt(parts[2], 10, 64)
					if len(parts) == 7 {
						attempt, err := strconv.ParseInt(parts[4], 10, 32)
						if err != nil || attempt <= 0 {
							writeConfirmationDispatchError(w, &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"})
							return
						}
						subject.Attempt = int32(attempt)
						subject.PayloadDigest = parts[6]
					}
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
			if command == "workspace.head" {
				// The service resolves publisher vs retained-source authority
				// from the decoded immutable report, and obtains the one decision.
				next.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(command, "workspace.children.") {
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
				if command == "workspace.children.spawn" {
					raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
					if err != nil {
						writeConfirmationDispatchError(w, pkgerrors.BadRequest("invalid children request"))
						return
					}
					input, err := routes.DecodeWorkspaceChildrenSpawn(bytes.NewReader(raw))
					if err != nil {
						writeConfirmationDispatchError(w, err)
						return
					}
					input.RepositoryID, input.ParentWorkspaceID = subject.RepositoryID, subject.WorkspaceID
					subject, err = services.InstallWorkspaceChildrenSpawnSubject(input)
					if err != nil {
						writeConfirmationDispatchError(w, err)
						return
					}
					r.Body = io.NopCloser(bytes.NewReader(raw))
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
			// Credential inventory and revocation are self-authentication protocols,
			// not repository commands. Only the signed-in person manages them;
			// member sessions use the same own-user service filters as the owner.
			credentialInventory := (r.Method == http.MethodGet || r.Method == http.MethodDelete) &&
				(strings.HasPrefix(r.URL.Path, "/api/user/tokens") || strings.HasPrefix(r.URL.Path, "/api/user/sessions"))
			sshKeyManagement := (r.Method == http.MethodPost || r.Method == http.MethodDelete) && strings.HasPrefix(r.URL.Path, "/api/user/keys")
			if command == "self" && (credentialInventory || sshKeyManagement) && info != nil && info.User != nil && info.CredentialKind() != middleware.CredentialPerson {
				writeConfirmationDispatchError(w, &services.AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available"})
				return
			}
			if command == "github.account-read" && (info == nil || info.User == nil) {
				_, err := services.Authorize(r.Context(), queries, command)
				writeConfirmationDispatchError(w, err)
				return
			}
			if info == nil || info.User == nil || command == "" || command == "self" || command == "public" {
				next.ServeHTTP(w, r)
				return
			}
			// The file service validates and owns the entire batch before its one
			// command decision, including direct service entries.
			if command == "flow.source-coedit" {
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
				// The restore handler validates the complete payload and resolves the stored
				// workspace before its authorizer binds the single concrete decision.
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
		part, decodeErr := url.PathUnescape(strings.Split(strings.TrimPrefix(r.URL.EscapedPath(), "/api/todos/"), "/")[0])
		n, err := strconv.ParseInt(part, 10, 64)
		if decodeErr != nil || err != nil || n <= 0 {
			writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_todo", Message: "Invalid TODO number"})
			return true
		}
		input.Subject, _ = json.Marshal(map[string]string{"kind": "todo", "ref": "T" + strconv.FormatInt(n, 10)})
	}
	if command == "branch.add-to-stack" || command == "branch.archive" {
		suffix := "/" + strings.TrimPrefix(command, "branch.")
		part := strings.TrimSuffix(strings.TrimPrefix(r.URL.EscapedPath(), "/api/branches/"), suffix)
		branch, err := url.PathUnescape(part)
		if err != nil || branch == "" {
			writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid branch"})
			return true
		}
		input.Subject, _ = json.Marshal(map[string]string{"kind": "branch", "ref": branch})
	}
	if command == "merge" {
		parts := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
		if len(parts) == 8 && parts[1] == "repos" && parts[4] == "mythical" && parts[5] == "items" && parts[7] == "merge" {
			id, err := url.PathUnescape(parts[6])
			if err != nil {
				writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid confirmation request"})
				return true
			}
			// The consumer resolves this legacy identity after the one policy
			// decision, then stores the same canonical TODO subject as the card.
			input.Subject, _ = json.Marshal(map[string]string{"kind": "todo-id", "ref": id, "owner": parts[2], "repo": parts[3]})
		}
	}
	if command == "branch.discard-foreign" || command == "branch.bring-in" {
		input.Subject, _ = json.Marshal(map[string]string{"kind": "branch", "ref": strings.TrimPrefix(r.URL.Path, "/api/branches/")})
		var body map[string]json.RawMessage
		if json.Unmarshal(raw, &body) == nil {
			delete(body, "op")
			input.Payload, _ = json.Marshal(body)
		}
	}
	if command == "agent.edit" {
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/agents/"), "/edit")
		input.Subject, _ = json.Marshal(map[string]string{"kind": "agent", "ref": name})
	}
	if command == "flow.edit" {
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/flows/"), "/edit")
		input.Subject, _ = json.Marshal(map[string]string{"kind": "flow", "ref": name})
	}
	if command == "wiki.delete" {
		parts := strings.Split(r.URL.EscapedPath(), "/")
		if len(parts) != 7 {
			writeConfirmationDispatchError(w, &services.AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid wiki page"})
			return true
		}
		owner, _ := url.PathUnescape(parts[3])
		repo, _ := url.PathUnescape(parts[4])
		slug, _ := url.PathUnescape(parts[6])
		input.Subject, _ = json.Marshal(map[string]string{"kind": "wiki", "ref": slug})
		input.Payload, _ = json.Marshal(map[string]string{"owner": owner, "repo": repo, "visibility": r.URL.Query().Get("visibility")})
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
	var branch *services.BranchError
	var api *pkgerrors.APIError
	w.Header().Set("Content-Type", "application/json")
	switch {
	case stdErrors.As(err, &access):
		w.WriteHeader(access.Status)
		_ = json.NewEncoder(w).Encode(access)
	case stdErrors.As(err, &control):
		w.WriteHeader(control.Status)
		_ = json.NewEncoder(w).Encode(control)
	case stdErrors.As(err, &branch):
		w.WriteHeader(branch.Status)
		_ = json.NewEncoder(w).Encode(branch)
	case stdErrors.As(err, &api):
		pkgerrors.WriteError(w, api)
	default:
		pkgerrors.WriteError(w, pkgerrors.Internal("Confirmation unavailable").WithCause(err))
	}
}
