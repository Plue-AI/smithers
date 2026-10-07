package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// prepareMergeConfirmation reads the same subject and readiness projection as
// the TODO card. Requesting a card never records merge authority or sends GitHub
// a write. Only MergeTodo, called later with a person's session, admits it.
func (s *MythicalService) prepareMergeConfirmation(ctx context.Context, tx pgx.Tx, repository int64, input ConfirmationInput, inspect bool, member db.User) (preparedConfirmation, error) {
	p := preparedConfirmation{}
	if s.github == nil || s.outbound.MergeDecision == nil || s.outbound.Lookup == nil || s.outbound.PrepareMerge == nil || s.outbound.Settle == nil {
		return p, confirmationUnavailable()
	}
	var subject struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	}
	var request MythicalMergeInput
	if confirmationJSON(input.Subject, &subject) != nil || subject.Kind != "todo" || !strings.HasPrefix(subject.Ref, "T") || confirmationJSON(input.Payload, &request) != nil {
		return p, invalidConfirmation()
	}
	number, err := strconv.ParseInt(strings.TrimPrefix(subject.Ref, "T"), 10, 64)
	if err != nil || number <= 0 || subject.Ref != "T"+strconv.FormatInt(number, 10) {
		return p, invalidConfirmation()
	}
	// A delegated request asks the person to review; it need not have read
	// the PR head. Preserve that literal input for idempotent replay while
	// binding the private card to the head observed under the subject lock.
	if request.Head != "" {
		request.Head, err = mythicalReviewedHead(request.Head)
		if err != nil {
			return p, err
		}
	}
	p.input, _ = json.Marshal(request)
	p.subject, _ = json.Marshal(subject)
	if !inspect {
		return p, nil
	}
	if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_items WHERE repository_id=$1 AND number=$2 FOR UPDATE`, repository, number); err != nil {
		return p, err
	}
	item, err := db.New(tx).GetMythicalItemByNumber(ctx, repository, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, &TodoControlError{Status: 404, Class: "user", Code: "todo_not_found", Message: "TODO not found"}
	}
	if err != nil {
		return p, err
	}
	if s.github == nil || s.outbound.MergeDecision == nil || s.outbound.Lookup == nil || s.outbound.PrepareMerge == nil || s.outbound.Settle == nil {
		return p, confirmationUnavailable()
	}
	if request.Head == "" {
		request.Head, err = mythicalReviewedHead(item.PRHead)
		if err != nil {
			return p, confirmationUnavailable()
		}
	}
	p.mergeHead = request.Head
	if item.PRHead != request.Head {
		return p, &MythicalStaleHeadError{TodoControlError: *mythicalMergeConflict("stale_head", "the pull request changed since you saw it"), CurrentHead: item.PRHead}
	}
	p.revision = uuidString(item.ID) + ":" + strconv.FormatInt(item.Generation, 10) + ":" + request.Head
	p.title = item.Title.String
	consumer := *s
	consumer.store = tx
	merge, err := consumer.todoMerge(ctx, item)
	if err != nil {
		return p, err
	}
	// A refusal describes the previous press; a fresh person press runs the
	// existing readiness predicate again rather than inheriting its refusal.
	if land := mythicalChecksOf(item).Land; land != nil && land.Refused != nil && !mythicalMergeFenced(item) {
		before, readErr := mythicalMergeAfter(ctx, tx, item)
		if readErr != nil {
			return p, readErr
		}
		if mythicalMergeReady(item, before, request.Head, false) == nil {
			merge = map[string]any{"state": "ready", "detail": land.Refused.Message, "on_github": true}
		}
	}
	repositoryRow, owner, err := consumer.repository(ctx, repository)
	if err != nil {
		return p, err
	}
	gh, err := s.github.Resolve(ctx, repositoryRow, owner, member.ID)
	if err != nil {
		return p, confirmationUnavailable()
	}
	facts, err := s.github.HeadCheckFacts(ctx, gh, request.Head)
	if err != nil {
		return p, confirmationUnavailable()
	}
	if !mythicalIsTodo(item) || !item.PRNumber.Valid || !item.StackPosition.Valid || item.Attempt <= 0 {
		return p, confirmationUnavailable()
	}
	evidence := currentTodoEvidence(item)
	for _, fact := range facts {
		state := "pending"
		if fact.State == mythicalCIGreen {
			state = "passed"
		} else if fact.State == mythicalCIRed {
			state = "failed"
		}
		evidence.Items = append(evidence.Items, map[string]any{"kind": "github_check", "name": fact.Name, "required": fact.Required, "state": state, "url": fmt.Sprintf("https://github.com/%s/%s/pull/%d/checks", gh.Owner, gh.Name, item.PRNumber.Int64)})
	}
	if err := mythicalMergeCheckFacts(facts); err != nil {
		var refusal *TodoControlError
		if !errors.As(err, &refusal) {
			return p, confirmationUnavailable()
		}
		merge = map[string]any{"state": "waiting", "reason": "checks", "detail": refusal.Message, "on_github": true}
	}
	p.card = map[string]any{"kind": "review_merge", "action": map[string]string{"tag": "merge", "verb": "Review & merge"}, "summary": p.title, "subject": map[string]string{"kind": "todo", "ref": subject.Ref, "revision": request.Head}, "asked_by": todoActor(ctx, member), "review": map[string]any{"title": p.title, "place": item.StackPosition.Int64, "pr": map[string]any{"number": item.PRNumber.Int64, "url": item.PRURL}, "evidence": evidence, "merge": merge}}
	return p, nil
}

// admitMergeConfirmation keeps the row pending. An outbound admission is not
// a merge receipt; the existing merge worker alone establishes completion.
func (s *ApprovalsService) admitMergeConfirmation(ctx context.Context, tx pgx.Tx, repository int64, id, key string, prepared preparedConfirmation) (ConfirmationReceipt, error) {
	info := middleware.AuthInfoFromContext(ctx)
	review := prepared.card["review"].(map[string]any)
	merge := review["merge"].(map[string]any)
	if merge["state"] != "ready" {
		code, _ := merge["reason"].(string)
		if code == "" {
			code = "rechecking"
		}
		detail, _ := merge["detail"].(string)
		if detail == "" {
			detail = "Review the current merge state"
		}
		return ConfirmationReceipt{}, mythicalMergeConflict(code, detail)
	}
	var subject struct {
		Ref string `json:"ref"`
	}
	var request MythicalMergeInput
	if json.Unmarshal(prepared.subject, &subject) != nil || json.Unmarshal(prepared.input, &request) != nil {
		return ConfirmationReceipt{}, invalidConfirmation()
	}
	// prepare and the stored revision comparison have already rechecked the
	// exact head shown to this person. Direct MergeTodo still requires a SHA.
	request.Head = prepared.mergeHead
	number, _ := strconv.ParseInt(strings.TrimPrefix(subject.Ref, "T"), 10, 64)
	pressDigest := sha256.Sum256([]byte(key))
	request.Request = "confirmation:" + id + ":" + hex.EncodeToString(pressDigest[:])
	consumer := *s.confirmationTodos
	consumer.store = tx
	if _, err := consumer.MergeTodo(ctx, repository, info.User.ID, number, request); err != nil {
		return ConfirmationReceipt{}, err
	}
	name := info.User.DisplayName
	if name == "" {
		name = info.User.Username
	}
	effect, _ := json.Marshal(map[string]any{"todo": number, "request": "confirmation:" + id})
	by, _ := json.Marshal(map[string]string{"login": info.User.Username, "name": name, "avatar_url": todoAvatar(*info.User)})
	_, err := tx.Exec(ctx, `UPDATE approvals SET decision_credential=$2,decision_key=$3,payload=jsonb_set(jsonb_set(jsonb_set(jsonb_set(payload,'{effect}',$4::jsonb),'{merge_by}',$5::jsonb),'{merge_presses}',COALESCE(payload->'merge_presses','[]'::jsonb)||jsonb_build_array(jsonb_build_object('credential',$2::text,'key',$3::text))),'{card,review,merge}', '{"state":"merging","reason":"merging","on_github":true}'::jsonb) WHERE id=$1 AND state='pending'`, id, info.SessionHash, key, effect, by)
	if err == nil {
		_, err = tx.Exec(ctx, `UPDATE approvals SET payload=jsonb_set(payload,'{merge_request}',to_jsonb($2::text)) WHERE id=$1`, id, request.Request)
	}
	return ConfirmationReceipt{ID: id, State: "pending"}, err
}

// RefreshConfirmationCards reprojects existing private rows; it never admits an
// operation or manufactures execution authority. The HTTP/live caller has
// already restricted the projection to this member.
func (s *MythicalService) RefreshConfirmationCards(ctx context.Context, member int64, rows []db.Confirmation) error {
	if s == nil || s.store == nil {
		return nil
	}
	person, err := s.queries().GetUserByID(ctx, member)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.Command != "merge" || row.State != "pending" {
			continue
		}
		var stored struct {
			Input  json.RawMessage `json:"input"`
			Effect json.RawMessage `json:"effect"`
			Card   map[string]any  `json:"card"`
		}
		if json.Unmarshal(row.Payload, &stored) != nil || len(stored.Input) == 0 || len(stored.Effect) > 0 {
			continue
		}
		err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
			repository, err := InstallRepositoryID(ctx, db.New(tx))
			if err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, repository); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
				return err
			}
			current, err := db.New(tx).GetMemberConfirmation(ctx, row.ID, member)
			if err != nil {
				return err
			}
			if current.State != "pending" {
				return nil
			}
			var latest struct {
				Effect json.RawMessage `json:"effect"`
			}
			_ = json.Unmarshal(current.Payload, &latest)
			if len(latest.Effect) > 0 {
				return nil
			}
			p, prepareErr := s.prepareMergeConfirmation(ctx, tx, repository, ConfirmationInput{Command: "merge", Subject: current.Subject, Payload: stored.Input}, true, person)
			if confirmationSubjectChanged(prepareErr) || p.revision != "" && p.revision != current.Revision {
				_, err = db.New(tx).SettleMemberConfirmation(ctx, row.ID, member, "expired")
				return err
			}
			if prepareErr != nil {
				return nil
			} // Outages grant no authority; a press still refuses.
			p.card["asked_by"] = stored.Card["asked_by"]
			card, err := json.Marshal(p.card)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `UPDATE approvals SET payload=jsonb_set(payload,'{card}',$2::jsonb) WHERE id=$1 AND state='pending' AND NOT (payload ? 'effect') AND payload->'card' IS DISTINCT FROM $2::jsonb`, row.ID, card)
			return err
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *ApprovalsService) RefreshConfirmationCards(ctx context.Context, member int64, rows []db.Confirmation) error {
	if s == nil || s.confirmationTodos == nil {
		return nil
	}
	return s.confirmationTodos.RefreshConfirmationCards(ctx, member, rows)
}
