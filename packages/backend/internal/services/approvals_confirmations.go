package services

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// CatalogPolicy is generated from the same Operation descriptors the host and
// CLI consume. It is not a second declaration of command policy.
type CatalogPolicy struct {
	CredentialScope string   `json:"credentialScope"`
	Agent           string   `json:"agent"`
	MinimumRole     string   `json:"minimumRole"`
	Actors          []string `json:"actors"`
	Visibility      string   `json:"visibility"`
}

var operationCatalog = func() map[string]CatalogPolicy {
	var rows map[string]CatalogPolicy
	if err := json.Unmarshal([]byte(operationCatalogJSON), &rows); err != nil {
		panic(err)
	}
	return rows
}()

func OperationPolicy(command string) (CatalogPolicy, bool) {
	row, ok := operationCatalog[command]
	row.Actors = slices.Clone(row.Actors)
	return row, ok
}

// ConfirmationRequired retains the ordinary unavailable response for a caller
// without a confirmation consumer. A consumer may persist a request, never
// use this decision to execute the command as the delegated credential.
type ConfirmationRequired struct {
	Decision InstallAuthorization
	Command  string
	Refusal  *AccessError
}

func (e *ConfirmationRequired) Error() string { return e.Refusal.Error() }
func (e *ConfirmationRequired) Unwrap() error { return e.Refusal }

func requireConfirmation(info *middleware.AuthInfo, command string, decision InstallAuthorization, fallback *AccessError) error {
	row, ok := OperationPolicy(command)
	if !ok || row.Agent != "confirm" || row.Visibility == "hidden" {
		return fallback
	}
	if decision.Role.rank() < InstallRole(row.MinimumRole).rank() {
		return confirmationPermission()
	}
	actor := "external_agent"
	if delegated, ok := info.Delegation(); ok && delegated.Via == "smithers" {
		actor = "app_agent"
	}
	if !slices.Contains(row.Actors, actor) {
		return &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not available to this agent"}
	}
	return &ConfirmationRequired{Decision: decision, Command: command, Refusal: fallback}
}

// WithConfirmationTodos composes the existing TODO service as the transactional
// consumer. Merge uses its durable outbound admission and confirmed settlement;
// missing consumers refuse before any confirmation or subject effect.
func WithConfirmationTodos(store MythicalStore, todos *MythicalService) ApprovalsServiceOption {
	return func(s *ApprovalsService) { s.confirmationStore, s.confirmationTodos = store, todos }
}

type ConfirmationInput struct {
	Command string          `json:"command"`
	Subject json.RawMessage `json:"subject"`
	Payload json.RawMessage `json:"payload"`
	Key     string          `json:"-"`
}
type ConfirmationReceipt struct {
	ID    string `json:"confirmation"`
	State string `json:"state"`
}

func confirmationUnavailable() error {
	return &AccessError{Status: 503, Class: "infra", Code: "confirmation_unavailable", Message: "Confirmation unavailable"}
}
func invalidConfirmation() error {
	return &AccessError{Status: 400, Class: "user", Code: "invalid_confirmation", Message: "Invalid confirmation request"}
}
func confirmationPermission() error {
	return &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Not your confirmation"}
}
func confirmationResolved() error {
	return &AccessError{Status: 409, Class: "conflict", Code: "confirmation_resolved", Message: "Confirmation changed or was already answered"}
}

func confirmationJSON(raw []byte, out any) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(out); err != nil {
		return invalidConfirmation()
	}
	var extra any
	if !errors.Is(d.Decode(&extra), io.EOF) {
		return invalidConfirmation()
	}
	return nil
}

// lockInstallWriteCredential serializes command writes with role changes, member suspension and
// credential revocation before reloading the actual credential. The roster
// owner is locked before user/session rows, as member removal requires. The
// repository and stack retain the existing TODO transaction order.
func lockInstallWriteCredential(ctx context.Context, tx pgx.Tx, info *middleware.AuthInfo) (context.Context, int64, error) {
	if info == nil || info.User == nil {
		return ctx, 0, confirmationPermission()
	}
	q := db.New(tx)
	repository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return ctx, 0, err
	}
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`SELECT 1 FROM self_host_owners WHERE singleton FOR SHARE`, nil},
		{`SELECT pg_advisory_xact_lock($1)`, []any{repository}},
		{`SELECT 1 FROM repositories WHERE id=$1 FOR SHARE`, []any{repository}},
		{`SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, []any{repository}},
		{`SELECT 1 FROM users WHERE id=$1 FOR SHARE`, []any{info.User.ID}},
		{`SELECT 1 FROM auth_sessions WHERE session_key=$1 FOR SHARE`, []any{info.SessionHash}},
		{`SELECT 1 FROM access_tokens WHERE id=$1 FOR SHARE`, []any{info.TokenID}},
		{`SELECT 1 FROM collaborators WHERE repository_id=$1 AND user_id=$2 FOR SHARE`, []any{repository, info.User.ID}},
		{`SELECT 1 FROM install_settings WHERE key IN ('github.repository','owner.access') ORDER BY key FOR SHARE`, nil},
	} {
		if _, err = tx.Exec(ctx, query.sql, query.args...); err != nil {
			return ctx, 0, err
		}
	}
	// The install binding may have moved while we acquired its locks. Never
	// authorize the new repository and then mutate the previously read one.
	currentRepository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return ctx, 0, err
	}
	if currentRepository != repository {
		return ctx, 0, confirmationResolved()
	}
	fresh, err := middleware.ReloadCredential(ctx, q, middleware.CredentialOf(info), time.Now())
	if errors.Is(err, middleware.ErrCredentialGone) {
		return ctx, 0, &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if err != nil {
		return ctx, 0, err
	}
	if !middleware.BindInstallCredential(fresh) {
		return ctx, 0, confirmationPermission()
	}
	fresh.ViaHint = info.ViaHint
	if fresh.User.ID != info.User.ID {
		return ctx, 0, confirmationPermission()
	}
	return middleware.ContextWithAuthInfo(ctx, fresh), repository, nil
}

var confirmationNamespace = uuid.MustParse("8dd896cf-923d-4510-b2c6-f499d9fb47bd")

// RequestConfirmation writes one private approvals row. No TODO, run, GitHub
// write or approval effect occurs while the delegated caller requests it.
func (s *ApprovalsService) RequestConfirmation(ctx context.Context, input ConfirmationInput) (ConfirmationReceipt, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil || info.CredentialKind() != middleware.CredentialDelegated {
		return ConfirmationReceipt{}, confirmationPermission()
	}
	if s == nil || s.confirmationStore == nil {
		if _, terminal := info.TerminalDelegation(); terminal && input.Command == "todo.new" {
			return ConfirmationReceipt{}, &AccessError{Status: 403, Class: "permission", Code: "confirm_in_app", Message: "Confirm in the app"}
		}
		return ConfirmationReceipt{}, confirmationUnavailable()
	}
	if input.Key == "" || len(input.Key) > 256 || len(input.Payload) > MaxApprovalPayloadBytes {
		return ConfirmationReceipt{}, invalidConfirmation()
	}
	var receipt ConfirmationReceipt
	err := pgx.BeginFunc(ctx, s.confirmationStore, func(tx pgx.Tx) error {
		bound, repository, err := lockInstallWriteCredential(ctx, tx, info)
		if err != nil {
			return err
		}
		q := db.New(tx)
		_, err = Authorize(bound, q, input.Command)
		var required *ConfirmationRequired
		if !errors.As(err, &required) {
			if err != nil {
				return err
			}
			return confirmationPermission()
		}
		fresh := middleware.AuthInfoFromContext(bound)
		delegation, ok := fresh.Delegation()
		_, terminal := fresh.TerminalDelegation()
		if terminal {
			var request MythicalTodoInput
			if input.Command != "todo.new" || confirmationJSON(input.Payload, &request) != nil || request.Issue != nil || request.Place.Mode != "" && request.Place.Mode != "append" {
				return confirmationPermission()
			}
		}
		if !ok || !terminal && (delegation.Profile != "" || delegation.Branch != "") || fresh.WorkspaceRestriction() != "" || len(middleware.ParseTokenPathRestrictions(fresh.RawScopes)) != 0 || fresh.RepositoryRestriction() != 0 && fresh.RepositoryRestriction() != repository {
			return confirmationPermission()
		}
		if s.confirmationTodos == nil {
			if terminal {
				return required.Refusal
			}
			return confirmationUnavailable()
		}
		credential, err := todoRequestCredential(bound, fresh.User.ID)
		if err != nil {
			return err
		}
		id := uuid.NewSHA1(confirmationNamespace, []byte(strconv.FormatInt(repository, 10)+"\x00"+credential+"\x00"+input.Key)).String()
		prepared, err := s.confirmationTodos.prepareConfirmation(bound, tx, repository, input, false, required.Decision.Role)
		if err != nil {
			return err
		}
		var existingCommand, existingSubject, existingInput, state, revision string
		var expires time.Time
		var mergeAdmitted bool
		err = tx.QueryRow(bound, `SELECT command,subject::text,payload->>'input',state,revision,expires_at,command='merge' AND payload ? 'effect' FROM approvals WHERE id=$1 AND member_id=$2 FOR UPDATE`, id, fresh.User.ID).
			Scan(&existingCommand, &existingSubject, &existingInput, &state, &revision, &expires, &mergeAdmitted)
		if err == nil {
			if existingCommand != input.Command || !jsonEqual([]byte(existingSubject), prepared.subject) || !jsonEqual([]byte(existingInput), prepared.input) {
				return todoRequestMismatch()
			}
			if state == "pending" && mergeAdmitted {
				receipt = ConfirmationReceipt{ID: id, State: state}
				return nil
			}
			stale := !expires.After(time.Now())
			if state == "pending" && !stale {
				current, inspectErr := s.confirmationTodos.prepareConfirmation(bound, tx, repository, input, true, required.Decision.Role)
				if inspectErr != nil && !confirmationSubjectChanged(inspectErr) {
					return inspectErr
				}
				stale = inspectErr != nil || revision != current.revision
			}
			if state == "pending" && stale {
				if _, err = tx.Exec(bound, `UPDATE approvals SET state='expired',decided_at=now() WHERE id=$1 AND state='pending'`, id); err != nil {
					return err
				}
				state = "expired"
			}
			receipt = ConfirmationReceipt{ID: id, State: state}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		prepared, err = s.confirmationTodos.prepareConfirmation(bound, tx, repository, input, true, required.Decision.Role)
		if err != nil {
			return err
		}
		kind := "one_click"
		var generation any
		var head any
		if input.Command == "merge" {
			kind = "review_merge"
			parts := strings.Split(prepared.revision, ":")
			generation, _ = strconv.ParseInt(parts[1], 10, 64)
			head = parts[2]
		}
		payload, _ := json.Marshal(map[string]any{"input": json.RawMessage(prepared.input), "card": prepared.card})
		_, err = tx.Exec(bound, `INSERT INTO approvals(id,repository_id,member_id,credential_id,command,subject,revision,kind,state,title,payload,expires_at,generation,reviewed_head_sha)
		 VALUES($1,$2,$3,$4,$5,$6,$7,$10,'pending',$8,$9,clock_timestamp()+interval '24 hours',$11,$12)`, id, repository, fresh.User.ID, credential, input.Command, prepared.subject, prepared.revision, prepared.title, payload, kind, generation, head)
		if err != nil {
			return err
		}
		receipt = ConfirmationReceipt{ID: id, State: "pending"}
		return nil
	})
	if err != nil {
		return ConfirmationReceipt{}, err
	}
	return receipt, nil
}

func jsonEqual(a, b []byte) bool {
	var left, right any
	if json.Unmarshal(a, &left) != nil || json.Unmarshal(b, &right) != nil {
		return false
	}
	x, _ := json.Marshal(left)
	y, _ := json.Marshal(right)
	return bytes.Equal(x, y)
}

type preparedConfirmation struct {
	subject, input  json.RawMessage
	revision, title string
	card            map[string]any
	mergeHead       string
}

// prepareConfirmation adapts existing transactional TODO consumers. Its switch
// describes availability and subject snapshots, never actor/role/agent policy.
func (s *MythicalService) prepareConfirmation(ctx context.Context, tx pgx.Tx, repository int64, input ConfirmationInput, inspect bool, role InstallRole) (preparedConfirmation, error) {
	if input.Command == "merge" {
		return s.prepareMergeConfirmation(ctx, tx, repository, input, inspect, *middleware.AuthInfoFromContext(ctx).User)
	}
	p := preparedConfirmation{}
	info := middleware.AuthInfoFromContext(ctx)
	var subject struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	}
	if len(input.Subject) > 0 && string(input.Subject) != "null" {
		if err := confirmationJSON(input.Subject, &subject); err != nil {
			return p, err
		}
	}
	text, verb := "", ""
	switch input.Command {
	case "learning.accept", "learning.dismiss":
		var empty struct{}
		if subject.Kind != "proposal" || subject.Ref == "" || len(subject.Ref) > 512 || confirmationJSON(input.Payload, &empty) != nil {
			return p, invalidConfirmation()
		}
		p.input = json.RawMessage(`{}`)
		var status, raw string
		if err := tx.QueryRow(ctx, `SELECT status,provenance_json FROM memory_notes WHERE id=$1 AND namespace_kind='flow' AND namespace_id=$2 FOR UPDATE`, subject.Ref, learningNamespace(repository)).Scan(&status, &raw); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return p, proposalError(409, "proposal_resolved", "Proposal changed")
			}
			return p, err
		}
		var note LearningProposalNote
		repo, owner, err := s.repository(ctx, repository)
		if err != nil {
			return p, err
		}
		if inspect && status != "pending" || json.Unmarshal([]byte(raw), &note) != nil || !learningNoteBound(note, owner+"/"+repo.Name) {
			return p, proposalError(409, "proposal_resolved", "Proposal changed")
		}
		sum := sha256.Sum256([]byte(raw))
		p.revision = hex.EncodeToString(sum[:])
		p.title, text, verb = note.Title, note.Prompt, "Make TODO"
		if input.Command == "learning.dismiss" {
			verb = "Dismiss"
		}
	case "todo.new", "todo.from-issue":
		var request MythicalTodoInput
		if err := confirmationJSON(input.Payload, &request); err != nil {
			return p, err
		}
		if request.Title == "" {
			first, _, _ := strings.Cut(strings.TrimSpace(request.Prompt), "\n")
			request.Title = todoClip(first, 256)
		}
		request.Request = input.Key
		var err error
		request, err = normalizeMythicalTodoInput(request)
		if err != nil {
			return p, err
		}
		if (input.Command == "todo.from-issue") != (request.Issue != nil) {
			return p, invalidConfirmation()
		}
		if (subject.Kind != "" || subject.Ref != "") && (subject.Kind != "todo" || subject.Ref != "new") {
			return p, invalidConfirmation()
		}
		subject.Kind, subject.Ref = "todo", "new"
		p.input, _ = json.Marshal(request)
		sum := sha256.Sum256(p.input)
		p.revision = hex.EncodeToString(sum[:])
		p.title, text, verb = request.Title, request.Prompt, "Commit"
		if request.Issue != nil {
			if s.github == nil {
				return p, confirmationUnavailable()
			}
			consumer := *s
			consumer.store = tx
			if _, err := consumer.readTodoIssue(ctx, repository, role, *request.Issue, request.IssueDigest); err != nil {
				return p, err
			}
		}
		if !inspect {
			p.subject, _ = json.Marshal(subject)
			return p, nil
		}
		var ready bool
		if err := tx.QueryRow(ctx, `SELECT state='active' FROM mythical_stacks WHERE repository_id=$1`, repository).Scan(&ready); err != nil || !ready {
			return p, confirmationUnavailable()
		}

	case "branch.bring-in", "branch.discard-foreign":
		var answer struct {
			ID       string `json:"id"`
			Revision string `json:"revision"`
		}
		if subject.Kind != "branch" || !mythicalTodoBranchValid(subject.Ref) || confirmationJSON(input.Payload, &answer) != nil || answer.ID == "" || len(answer.ID) > 128 || !mythicalSHA.MatchString(answer.Revision) || strings.Trim(answer.Revision, "0") == "" {
			return p, invalidConfirmation()
		}
		p.input, _ = json.Marshal(answer)
		p.revision = answer.Revision
		if !inspect {
			p.subject, _ = json.Marshal(subject)
			return p, nil
		}
		items, err := db.New(tx).ListMythicalGitHubBranchItems(ctx, repository)
		if err != nil {
			return p, err
		}
		var item *db.MythicalItem
		for i := range items {
			checks := mythicalChecksOf(items[i])
			if checks.Todo && checks.Branch == subject.Ref {
				if item != nil {
					return p, todoControlConflict("Branch has more than one TODO")
				}
				item = &items[i]
			}
		}
		if item == nil {
			return p, todoControlConflict("TODO is settled or merging")
		}
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_items WHERE id=$1 FOR UPDATE`, item.ID); err != nil {
			return p, err
		}
		locked, err := db.New(tx).GetMythicalItem(ctx, item.ID)
		if err != nil {
			return p, err
		}
		item = &locked
		if _, err := foreignPushAnswerWait(*item, answer.ID, answer.Revision); err != nil {
			return p, err
		}
		p.revision = uuidString(item.ID) + ":" + strconv.FormatInt(item.Version, 10) + ":" + strconv.FormatInt(item.Generation, 10) + ":" + answer.Revision
		text = answer.Revision
		p.title = item.Title.String
		verb = "Bring in"
		if input.Command == "branch.discard-foreign" {
			verb = "Discard"
		}
	case "todo.drop", "todo.amend":
		if subject.Kind != "todo" || !strings.HasPrefix(subject.Ref, "T") {
			return p, invalidConfirmation()
		}
		n, err := strconv.ParseInt(strings.TrimPrefix(subject.Ref, "T"), 10, 64)
		if err != nil || n <= 0 || subject.Ref != "T"+strconv.FormatInt(n, 10) {
			return p, invalidConfirmation()
		}
		var amendment TodoAmendInput
		if input.Command == "todo.amend" {
			if err := confirmationJSON(input.Payload, &amendment); err != nil {
				return p, err
			}
			var err error
			text, err = amendment.feedback()
			if err != nil {
				return p, err
			}
			p.input, _ = json.Marshal(amendment)
		} else {
			var request struct {
				Op string `json:"op"`
			}
			if err := confirmationJSON(input.Payload, &request); err != nil || request.Op != "drop" {
				return p, invalidConfirmation()
			}
			p.input, _ = json.Marshal(request)
		}
		if !inspect {
			p.subject, _ = json.Marshal(subject)
			return p, nil
		}
		if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR UPDATE`, repository, n); err != nil {
			return p, err
		}
		item, err := db.New(tx).GetMythicalItemByNumber(ctx, repository, n)
		if err != nil {
			return p, err
		}
		if input.Command == "todo.amend" {
			if !s.todoSteering || s.todoFlow == nil {
				return p, confirmationUnavailable()
			}
			if _, ok := s.launcher.(mythicalSteerer); !ok {
				return p, confirmationUnavailable()
			}
			_, _, _, err = prepareTodoAmend(ctx, item, TodoControlInput{Repository: repository, Actor: info.User.ID, Request: input.Key, Steer: &text}, amendment, todoActor(ctx, *info.User), todoActorRef(ctx, *info.User), s.now().UTC())
			verb = "Amend"
		} else {
			err = todoControlGuard(item, TodoControlInput{Op: "drop"}, todoControlFacts{})
			verb = "Drop"
		}
		if err != nil {
			return p, err
		}
		p.revision = uuidString(item.ID) + ":" + strconv.FormatInt(item.Version, 10) + ":" + strconv.FormatInt(item.Generation, 10)
		p.title = item.Title.String
	default:
		return p, confirmationUnavailable()
	}
	p.subject, _ = json.Marshal(subject)
	p.card = map[string]any{"kind": "one_click", "action": map[string]string{"tag": input.Command, "verb": verb}, "summary": p.title,
		"subject": map[string]string{"kind": subject.Kind, "ref": subject.Ref, "revision": p.revision}, "text": text,
		"asked_by": todoActor(ctx, *info.User)}
	return p, nil
}

func confirmationSubjectChanged(err error) bool {
	var control *TodoControlError
	return errors.Is(err, pgx.ErrNoRows) || errors.As(err, &control) && (control.Status == 409 || control.Status == 404)
}

// DecideConfirmation commits a person-authorized TODO operation and its
// pending-row CAS in the same transaction. A failed or interrupted transaction
// commits neither. The original turn credential need not survive: approval is
// a new request by the person's own live session, never delegated execution.
func (s *ApprovalsService) DecideConfirmation(ctx context.Context, id, decision, key string) (ConfirmationReceipt, error) {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil || info.IsTokenAuth || info.SessionHash == "" || info.IsAgent() {
		return ConfirmationReceipt{}, confirmationPermission()
	}
	if s == nil || s.confirmationStore == nil {
		return ConfirmationReceipt{}, confirmationUnavailable()
	}
	if key == "" || len(key) > 256 || (decision != "approve" && decision != "deny") {
		return ConfirmationReceipt{}, invalidConfirmation()
	}
	var receipt ConfirmationReceipt
	var refused error
	err := pgx.BeginFunc(ctx, s.confirmationStore, func(tx pgx.Tx) error {
		bound, repository, err := lockInstallWriteCredential(ctx, tx, info)
		if err != nil {
			return err
		}
		q := db.New(tx)
		if err := q.SettleMergedConfirmations(bound, info.User.ID, time.Now().UTC()); err != nil {
			return err
		}
		var command, state, revision string
		var subject, payload []byte
		var expires time.Time
		err = tx.QueryRow(bound, `SELECT command,state,subject,revision,payload,expires_at FROM approvals WHERE id=$1 AND member_id=$2 AND repository_id=$3 FOR UPDATE`, id, info.User.ID, repository).
			Scan(&command, &state, &subject, &revision, &payload, &expires)
		if errors.Is(err, pgx.ErrNoRows) {
			return confirmationPermission()
		}
		if err != nil {
			return err
		}
		authorized, err := Authorize(bound, q, command)
		if err != nil {
			return err
		}
		bound = WithInstallAuthorization(bound, command, authorized)
		previous, err := q.ConfirmationPress(bound, info.SessionHash, key)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		want := "approved"
		if decision == "deny" {
			want = "rejected"
		}
		if previous != "" {
			if previous == id && command == "merge" && decision == "approve" {
				var refusal mythicalMergeRefusal
				var saved struct {
					Refusals map[string]mythicalMergeRefusal `json:"merge_refusals"`
				}
				if json.Unmarshal(payload, &saved) == nil {
					refusal = saved.Refusals[key]
				}
				if refusal.Code != "" {
					return &TodoControlError{Status: 409, Class: refusal.Class, Code: refusal.Code, Message: refusal.Message}
				}
				if state == "pending" {
					receipt = ConfirmationReceipt{ID: id, State: state}
					return nil
				}
			}
			if previous != id || state != want {
				return todoRequestMismatch()
			}
			receipt = ConfirmationReceipt{ID: id, State: state}
			return nil
		}
		if state != "pending" {
			return confirmationResolved()
		}
		if command == "merge" {
			var saved map[string]json.RawMessage
			if json.Unmarshal(payload, &saved) == nil && len(saved["effect"]) > 0 {
				return mythicalMergeConflict("merging", "A merge is in flight")
			}
		}
		expire := func() error {
			_, err := q.SettleMemberConfirmation(bound, id, info.User.ID, "expired")
			refused = confirmationResolved()
			return err
		}
		if !expires.After(time.Now()) {
			return expire()
		}
		var stored struct {
			Input json.RawMessage `json:"input"`
		}
		readable := json.Unmarshal(payload, &stored) == nil && len(stored.Input) > 0
		input := ConfirmationInput{Command: command, Subject: subject, Payload: stored.Input, Key: "confirmation:" + id}
		var prepared preparedConfirmation
		if s.confirmationTodos != nil && readable {
			prepared, err = s.confirmationTodos.prepareConfirmation(bound, tx, repository, input, true, authorized.Role)
			if confirmationSubjectChanged(err) {
				return expire()
			}
			if err != nil {
				var access *AccessError
				var control *TodoControlError
				unavailable := errors.As(err, &access) && access.Status == 503 || errors.As(err, &control) && control.Status == 503
				if decision != "deny" || !unavailable {
					return err
				}
				// Cancellation grants no execution authority; a missing consumer
				// must not trap a pending request on the person's card.
				prepared.revision = revision
			}
			if prepared.revision != revision {
				return expire()
			}
		} else if decision == "approve" {
			return confirmationUnavailable()
		}
		if command == "merge" && decision == "approve" {
			receipt, err = s.admitMergeConfirmation(bound, tx, repository, id, key, prepared)
			var stale *MythicalStaleHeadError
			if errors.As(err, &stale) {
				return expire()
			}
			return err
		}
		if decision == "approve" {
			// Nested service transactions are pgx savepoints on this same tx;
			// ordinary TODO validation, attribution and durable scheduling remain
			// owned by the existing service.
			consumer := *s.confirmationTodos
			consumer.store = tx
			var number int64
			var amendedRevision int
			switch command {
			case "learning.accept", "learning.dismiss":
				var subject struct {
					Ref string `json:"ref"`
				}
				if err = json.Unmarshal(prepared.subject, &subject); err != nil {
					return err
				}
				var card LearningProposalCard
				card, err = consumer.ResolveLearningProposal(bound, repository, info.User.ID, subject.Ref, command == "learning.accept")
				if card.Todo != nil {
					number = card.Todo.N
				}
			case "todo.new", "todo.from-issue":
				var request MythicalTodoInput
				if err = json.Unmarshal(prepared.input, &request); err != nil {
					return err
				}
				request.Request = input.Key
				var item MythicalItemView
				item, err = consumer.FileTodo(bound, repository, info.User.ID, request)
				number = item.Number
			case "todo.amend":
				var subject struct {
					Ref string `json:"ref"`
				}
				var request TodoAmendInput
				if err = json.Unmarshal(prepared.subject, &subject); err != nil {
					return err
				}
				if err = json.Unmarshal(prepared.input, &request); err != nil {
					return err
				}
				number, _ = strconv.ParseInt(strings.TrimPrefix(subject.Ref, "T"), 10, 64)
				request.Repository, request.Actor, request.Request = repository, info.User.ID, input.Key
				var result TodoControlReceipt
				result, err = consumer.AmendTodo(bound, number, request)
				amendedRevision = result.Revision
			case "branch.bring-in", "branch.discard-foreign":
				var subject struct {
					Ref string `json:"ref"`
				}
				var answer struct {
					ID       string `json:"id"`
					Revision string `json:"revision"`
				}
				if err = json.Unmarshal(prepared.subject, &subject); err != nil {
					return err
				}
				if err = json.Unmarshal(prepared.input, &answer); err != nil {
					return err
				}
				var result TodoControlReceipt
				result, err = consumer.AnswerBranch(bound, subject.Ref, TodoControlInput{Repository: repository, Actor: info.User.ID, Request: input.Key, Op: strings.TrimPrefix(command, "branch."), Wait: answer.ID, Revision: answer.Revision})
				number = result.Number
			case "todo.drop":
				var subject struct {
					Ref string `json:"ref"`
				}
				if err = json.Unmarshal(prepared.subject, &subject); err != nil {
					return err
				}
				n, _ := strconv.ParseInt(strings.TrimPrefix(subject.Ref, "T"), 10, 64)
				number = n
				_, err = consumer.ControlTodo(bound, n, TodoControlInput{Repository: repository, Actor: info.User.ID, Request: input.Key, Op: "drop"})
			default:
				return confirmationUnavailable()
			}
			if err != nil {
				return err
			}
			// The private projection retains the admitted subject across a lost
			// response/reload. This is an admission receipt, never execution success.
			if number > 0 {
				effectInput := map[string]any{"todo": number, "request": input.Key}
				if amendedRevision > 0 {
					effectInput["revision"] = amendedRevision
				}
				effect, err := json.Marshal(effectInput)
				if err != nil {
					return err
				}
				if _, err = tx.Exec(bound, `UPDATE approvals SET payload=jsonb_set(payload,'{effect}',$2::jsonb) WHERE id=$1`, id, effect); err != nil {
					return err
				}
			}
		}
		changed, err := q.DecideMemberConfirmation(bound, id, info.User.ID, info.SessionHash, key, want)
		if err != nil {
			return err
		}
		if !changed {
			return confirmationResolved()
		}
		person := middleware.AuthInfoFromContext(bound).User
		name := person.DisplayName
		if name == "" {
			name = person.Username
		}
		decisionReceipt, err := json.Marshal(map[string]any{
			"by":     map[string]string{"login": person.Username, "name": name, "avatar_url": todoAvatar(*person)},
			"result": map[string]string{"approved": "done", "rejected": "cancelled"}[want],
			"text":   map[string]string{"approved": "Approved", "rejected": "Cancelled"}[want],
			"at":     time.Now().UTC().Format(time.RFC3339Nano),
		})
		if err != nil {
			return err
		}
		if _, err = tx.Exec(bound, `UPDATE approvals SET payload=jsonb_set(payload,'{card,receipt}',$2::jsonb) WHERE id=$1`, id, decisionReceipt); err != nil {
			return err
		}

		receipt = ConfirmationReceipt{ID: id, State: want}
		return nil
	})
	if err != nil {
		var duplicate *pgconn.PgError
		if errors.As(err, &duplicate) && duplicate.Code == "23505" {
			return ConfirmationReceipt{}, todoRequestMismatch()
		}
		return ConfirmationReceipt{}, err
	}
	if refused != nil {
		return ConfirmationReceipt{}, refused
	}
	return receipt, nil
}
