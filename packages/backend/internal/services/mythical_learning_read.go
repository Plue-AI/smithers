package services

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type LearningJournalRow struct {
	Seq       int    `json:"seq"`
	EventType string `json:"eventType"`
	Payload   any    `json:"payload"`
}
type LearningFailure struct {
	Signature string `json:"signature"`
	Text      string `json:"text"`
}
type LearningOutcome struct {
	Todo     int64             `json:"todo"`
	Failures []LearningFailure `json:"failures"`
}

// LearningSnapshot is immutable input data read by the isolated machine. The
// existing workspace credential is checked against the persisted learning run;
// it gains no write authority. Persisted TODO evidence survives lane retirement,
// unlike a deleted workspace's journal, so this adapter reuses that evidence.
type LearningSnapshot struct {
	Repository string               `json:"repository"`
	Todo       int64                `json:"todo"`
	Run        string               `json:"run"`
	State      string               `json:"state"`
	Change     string               `json:"change"`
	Commit     string               `json:"commit"`
	Attempts   []string             `json:"attempts"`
	Journal    []LearningJournalRow `json:"journal"`
	Outcomes   []LearningOutcome    `json:"outcomes"`
}

func learningReadBinding(info *middleware.AuthInfo, item db.MythicalItem, run string) error {
	learning := mythicalChecksOf(item).Learning
	if info == nil || !info.IsRunCredential() || info.RepositoryRestriction() != item.RepositoryID ||
		learning == nil || learning.WorkspaceID == "" || !strings.EqualFold(middleware.ParseTokenLandingWorkspace(info.RawScopes), learning.WorkspaceID) {
		return pkgerrors.Forbidden("Learning evidence belongs to its run")
	}
	if item.State != "landed" || item.PRMergeCommit == "" || !item.Number.Valid ||
		learning.State != "requested" && learning.State != "running" {
		return pkgerrors.Conflict("Learning evidence is unavailable")
	}
	if run == "" || len(run) > 512 || strings.TrimSpace(run) != run {
		return pkgerrors.BadRequest("Invalid learning run")
	}
	if learning.RunID == "" {
		return &TodoControlError{Status: http.StatusServiceUnavailable, Code: "learning_starting", Class: "infra", Message: "Learning is starting"}
	}
	if learning.RunID != run {
		return pkgerrors.Forbidden("Learning evidence belongs to its run")
	}
	return nil
}

func (s *MythicalService) LearningSnapshot(ctx context.Context, repositoryID, number int64, run string) (LearningSnapshot, error) {
	q := s.queries()
	item, err := q.GetMythicalItemByNumber(ctx, repositoryID, number)
	if errors.Is(err, pgx.ErrNoRows) {
		return LearningSnapshot{}, pkgerrors.NotFound("TODO not found")
	}
	if err != nil {
		return LearningSnapshot{}, err
	}
	if err = learningReadBinding(middleware.AuthInfoFromContext(ctx), item, run); err != nil {
		return LearningSnapshot{}, err
	}
	repository, owner, err := s.repository(ctx, repositoryID)
	if err != nil {
		return LearningSnapshot{}, err
	}
	// Read only a bounded canonical stack window, never all repository history.
	rows, err := s.store.Query(ctx, `SELECT id FROM mythical_items WHERE repository_id=$1 AND state='landed' AND number IS NOT NULL ORDER BY stack_position DESC NULLS LAST, number DESC LIMIT 20`, repositoryID)
	if err != nil {
		return LearningSnapshot{}, err
	}
	var ids []pgtype.UUID
	for rows.Next() {
		var id pgtype.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return LearningSnapshot{}, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return LearningSnapshot{}, err
	}
	history := make([]db.MythicalItem, 0, len(ids))
	for i := len(ids) - 1; i >= 0; i-- {
		prior, e := q.GetMythicalItem(ctx, ids[i])
		if e != nil {
			return LearningSnapshot{}, e
		}
		history = append(history, prior)
	}
	return learningSnapshotOf(owner+"/"+repository.Name, item, history), nil
}

func learningSnapshotOf(repository string, item db.MythicalItem, history []db.MythicalItem) LearningSnapshot {
	checks := mythicalChecksOf(item)
	snapshot := LearningSnapshot{Repository: repository, Todo: item.Number.Int64, State: "merged", Change: fmt.Sprintf("T%d", item.Number.Int64), Commit: item.PRMergeCommit, Attempts: []string{}, Journal: []LearningJournalRow{}, Outcomes: []LearningOutcome{}}
	if checks.Learning != nil {
		snapshot.Run = checks.Learning.RunID
	}
	runs := []string{item.RequestRunID, item.VibeRunID, item.VerifyRunID}
	if checks.Review != nil {
		runs = append(runs, checks.Review.RunID)
	}
	seen := map[string]bool{}
	for _, run := range runs {
		if run != "" && !seen[run] {
			snapshot.Attempts = append(snapshot.Attempts, todoClip(run, 512))
			seen[run] = true
		}
	}
	add := func(event string, payload any) {
		if len(snapshot.Journal) < 128 {
			snapshot.Journal = append(snapshot.Journal, LearningJournalRow{Seq: len(snapshot.Journal) + 1, EventType: event, Payload: payload})
		}
	}
	decision := func(text string) {
		if strings.TrimSpace(text) != "" {
			add("control.agent.steering-drained", map[string]any{"messages": []any{map[string]any{"role": "user", "text": todoClip(text, 1024)}}})
		}
	}
	for _, steer := range checks.Steers {
		decision(steer.Text)
	}
	for _, answer := range todoAnswers(item) {
		decision(answer.Question + "\n" + answer.Answer)
	}
	if item.Summary != "" {
		add("control.agent.model-settled", map[string]any{"text": todoClip(item.Summary, 1024)})
	}
	if len(history) > 20 {
		history = history[len(history)-20:]
	}
	todos := map[int64]bool{}
	for _, prior := range history {
		if prior.State != "landed" || !prior.Number.Valid || prior.Number.Int64 <= 0 || todos[prior.Number.Int64] {
			continue
		}
		todos[prior.Number.Int64] = true
		failures := []LearningFailure{}
		signatures := map[string]bool{}
		for _, attempt := range todoEvidence(prior) {
			for _, evidence := range attempt.Items {
				kind, _ := evidence["kind"].(string)
				state, _ := evidence["state"].(string)
				name, _ := evidence["name"].(string)
				if kind != "check" || state != "failed" || strings.TrimSpace(name) == "" {
					continue
				}
				signature := "check:" + todoClip(name, 128) + "@verify"
				if signatures[signature] || len(failures) >= 16 {
					continue
				}
				signatures[signature] = true
				failures = append(failures, LearningFailure{Signature: signature, Text: todoClip(name+" failed at verify", 400)})
			}
		}
		snapshot.Outcomes = append(snapshot.Outcomes, LearningOutcome{Todo: prior.Number.Int64, Failures: failures})
	}
	return snapshot
}
