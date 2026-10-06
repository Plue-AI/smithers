package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// LearningProposalCard is the retained ProposalCard wire contract. Provenance
// is read from the existing memory note; proposed source remains quoted data.
type LearningProposalCard struct {
	ID       string                `json:"id"`
	Title    string                `json:"title"`
	Evidence []string              `json:"evidence"`
	Refs     []LearningProposalRef `json:"refs"`
	State    string                `json:"state"`
	Todo     *LearningProposalTodo `json:"todo,omitempty"`
}
type LearningProposalRef struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}
type LearningProposalTodo struct {
	N     int64  `json:"n"`
	Title string `json:"title"`
}
type LearningProposalNote struct {
	LearningProposal
	Repository string `json:"repository"`
	Run        string `json:"run"`
}

func learningNamespace(repository int64) string {
	return "learning:" + strconv.FormatInt(repository, 10)
}
func proposalError(status int, code, message string) error {
	class := "user"
	if status == 409 {
		class = "conflict"
	}
	return &TodoControlError{status, code, class, message}
}
func proposalCard(id, status string, note LearningProposalNote, accepted *string) LearningProposalCard {
	card := LearningProposalCard{ID: id, Title: note.Title, Evidence: note.Evidence, Refs: []LearningProposalRef{}, State: "open"}

	if status == "rejected" {
		card.State = "dismissed"
	}
	if status == "accepted" {
		card.State = "accepted"
		if accepted != nil {
			n, _ := strconv.ParseInt(*accepted, 10, 64)
			if n > 0 {
				card.Todo = &LearningProposalTodo{n, note.Title}
			}
		}
	}
	return card
}

// LearningProposals projects only the bound install repository's learning
// namespace. Unrelated agent memory never reaches a Proposal card.
func (s *MythicalService) LearningProposals(ctx context.Context, repository int64) ([]LearningProposalCard, error) {
	repo, owner, err := s.repository(ctx, repository)
	if err != nil {
		return nil, err
	}
	expected := owner + "/" + repo.Name
	rows, err := s.store.Query(ctx, `SELECT id,status,provenance_json,accepted_todo FROM memory_notes WHERE namespace_kind='flow' AND namespace_id=$1 ORDER BY created_at_ms,id`, learningNamespace(repository))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cards := []LearningProposalCard{}
	for rows.Next() {
		var id, status, raw string
		var accepted *string
		if err = rows.Scan(&id, &status, &raw, &accepted); err != nil {
			return nil, err
		}
		var note LearningProposalNote
		if json.Unmarshal([]byte(raw), &note) != nil || !learningNoteBound(note, expected) {
			continue
		}
		card := proposalCard(id, status, note, accepted)
		if err = enrichLearningProposal(ctx, db.New(s.store), repository, note, &card); err != nil {
			return nil, err
		}
		cards = append(cards, card)
	}
	return cards, rows.Err()
}

// ResolveLearningProposal locks the existing note and appends through FileTodo
// using a savepoint on this same transaction. A failed append leaves it pending;
// replay from any member returns the one accepted TODO.
func (s *MythicalService) ResolveLearningProposal(ctx context.Context, repository, user int64, id string, accept bool) (LearningProposalCard, error) {
	command := "learning.dismiss"
	if accept {
		command = "learning.accept"
	}
	decision, err := Authorize(ctx, s.queries(), command)
	if err != nil {
		return LearningProposalCard{}, err
	}
	if decision.UserID != user {
		return LearningProposalCard{}, proposalError(403, "permission", "Not your request")
	}
	repo, owner, err := s.repository(ctx, repository)
	if err != nil {
		return LearningProposalCard{}, err
	}
	expected := owner + "/" + repo.Name
	var card LearningProposalCard
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var status, raw string
		var accepted *string
		err := tx.QueryRow(ctx, `SELECT status,provenance_json,accepted_todo FROM memory_notes WHERE id=$1 AND namespace_kind='flow' AND namespace_id=$2 FOR UPDATE`, id, learningNamespace(repository)).Scan(&status, &raw, &accepted)
		if errors.Is(err, pgx.ErrNoRows) {
			return proposalError(404, "proposal_not_found", "Proposal not found")
		}
		if err != nil {
			return err
		}
		var note LearningProposalNote
		if json.Unmarshal([]byte(raw), &note) != nil || !learningNoteBound(note, expected) {
			return proposalError(409, "proposal_invalid", "Proposal unavailable")
		}
		card = proposalCard(id, status, note, accepted)
		if err = enrichLearningProposal(ctx, db.New(tx), repository, note, &card); err != nil {
			return err
		}
		if accept && status == "accepted" || !accept && status == "rejected" {
			return nil
		}
		if status != "pending" {
			return proposalError(409, "proposal_resolved", "Proposal already resolved")
		}
		next := "rejected"
		if accept {
			clone := *s
			clone.store = tx
			contextBytes, _ := json.Marshal(note)
			item, err := clone.FileTodo(ctx, repository, user, MythicalTodoInput{Title: note.Title, Prompt: note.Prompt + "\n\nLearning evidence (quoted context):\n" + string(contextBytes), Request: "learning:" + id, Place: MythicalTodoPlace{Mode: "append"}})
			if err != nil {
				return err
			}
			n := strconv.FormatInt(item.Number, 10)
			accepted = &n
			next = "accepted"
		}
		_, err = tx.Exec(ctx, `UPDATE memory_notes SET status=$2,status_at_ms=$3,accepted_todo=$4 WHERE id=$1`, id, next, s.now().UnixMilli(), accepted)
		if err != nil {
			return err
		}
		card = proposalCard(id, next, note, accepted)
		if err = enrichLearningProposal(ctx, db.New(tx), repository, note, &card); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `SELECT pg_notify($1,'')`, "mythical_"+strconv.FormatInt(repository, 10))
		return err
	})
	return card, err
}

// Keep the shared database transaction interface explicit: pgx's nested Begin
// supplies the FileTodo savepoint, never a second connection.
var _ MythicalStore = (pgx.Tx)(nil)

// Reference labels resolve only recorded TODO pull requests; absent evidence
// never becomes an invented link to the repository homepage.
func enrichLearningProposal(ctx context.Context, q *db.Queries, repository int64, note LearningProposalNote, card *LearningProposalCard) error {
	for _, n := range note.Todos {
		item, err := q.GetMythicalItemByNumber(ctx, repository, n)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if item.PRURL != "" {
			card.Refs = append(card.Refs, LearningProposalRef{Label: "T" + strconv.FormatInt(n, 10), URL: item.PRURL})
		}
	}
	if card.Todo != nil {
		item, err := q.GetMythicalItemByNumber(ctx, repository, card.Todo.N)
		if err != nil {
			return err
		}
		card.Todo.Title = item.IssueTitle
	}
	return nil
}

// A namespace is a storage index, not proof of machine-output provenance.
// Refuse mismatched or unbound persisted output before any note or TODO effect.
func learningNoteBound(note LearningProposalNote, repository string) bool {
	return strings.EqualFold(note.Repository, repository) && strings.TrimSpace(note.Run) != "" && strings.TrimSpace(note.Signature) != ""
}
