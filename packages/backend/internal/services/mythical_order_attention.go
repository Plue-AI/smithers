package services

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// Order entries are append-only receipts within the stack row. Its lock
// serializes fetched folds, merge claims and a person's revision-bound OK.
type OrderAttentionEntry struct {
	Pull   int64  `json:"pr"`
	Commit string `json:"commit"`
	Text   string `json:"text"`
}
type OrderAttention struct {
	ID        string                `json:"id"`
	Kind      string                `json:"kind"`
	Revision  int64                 `json:"revision"`
	Text      string                `json:"text"`
	Entries   []OrderAttentionEntry `json:"entries"`
	SettledBy int64                 `json:"settled_by,omitempty"`
	SettledAt *time.Time            `json:"settled_at,omitempty"`
	Actions   []map[string]string   `json:"actions"`
}

func readStackAttention(ctx context.Context, q db.DBTX, repository int64) ([]OrderAttention, error) {
	var raw []byte
	if err := q.QueryRow(ctx, `SELECT attention FROM mythical_stacks WHERE repository_id=$1`, repository).Scan(&raw); err != nil {
		if err == pgx.ErrNoRows {
			return []OrderAttention{}, nil
		}
		return nil, err
	}
	var rows []OrderAttention
	err := json.Unmarshal(raw, &rows)
	return rows, err
}
func writeStackAttention(ctx context.Context, tx pgx.Tx, repository int64, rows []OrderAttention) error {
	raw, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE mythical_stacks SET attention=$2,updated_at=now() WHERE repository_id=$1`, repository, raw)
	return err
}
func appendOrderAttention(ctx context.Context, tx pgx.Tx, repository int64, entry OrderAttentionEntry) error {
	rows, err := readStackAttention(ctx, tx, repository)
	if err != nil {
		return err
	}
	for _, row := range rows {
		for _, old := range row.Entries {
			if old.Pull == entry.Pull && old.Commit == entry.Commit {
				return nil
			}
		}
	}
	index := -1
	for i, row := range rows {
		if row.Kind == "order" && row.SettledAt == nil {
			index = i
			break
		}
	}
	if index < 0 {
		rows = append(rows, OrderAttention{ID: uuid.NewString(), Kind: "order", Actions: []map[string]string{{"tag": "order.ok", "label": "OK"}}})
		index = len(rows) - 1
	}
	row := &rows[index]
	row.Entries = append(row.Entries, entry)
	row.Revision++
	texts := make([]string, len(row.Entries))
	for i, e := range row.Entries {
		texts[i] = e.Text
	}
	row.Text = strings.Join(texts, "\n")
	return writeStackAttention(ctx, tx, repository, rows)
}
func requireNoStackAttention(ctx context.Context, q db.DBTX, repository int64) error {
	rows, err := readStackAttention(ctx, q, repository)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.SettledAt == nil {
			return mythicalMergeConflict("attention", fmt.Sprintf("Stack attention %s is open", row.ID))
		}
	}
	return nil
}
func (s *MythicalService) StackAttention(ctx context.Context, repository, member int64) ([]OrderAttention, error) {
	role, err := InstallRoleOf(ctx, s.queries(), member)
	if err != nil {
		return nil, err
	}
	if role != InstallOwner && role != InstallMaintainer {
		return []OrderAttention{}, nil
	}
	rows, err := readStackAttention(ctx, s.store, repository)
	if err != nil {
		return nil, err
	}
	open := []OrderAttention{}
	for _, row := range rows {
		if row.SettledAt == nil && row.Kind == "order" {
			open = append(open, row)
		}
	}
	return open, nil
}
func (s *MythicalService) OrderOK(ctx context.Context, repository int64, id string, revision int64) error {
	if _, err := Authorize(ctx, s.queries(), "order.ok"); err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
			return err
		}
		// Do not reuse the HTTP decision after waiting for the row lock.
		decision, err := authorizePersonOnly(ctx, db.New(tx), middleware.AuthInfoFromContext(ctx), InstallMaintainer)
		if err != nil {
			return err
		}
		rows, err := readStackAttention(ctx, tx, repository)
		if err != nil {
			return err
		}
		for i := range rows {
			row := &rows[i]
			if row.ID != id {
				continue
			}
			if row.Revision == revision && row.SettledAt != nil && row.SettledBy == decision.UserID {
				return nil
			}
			if row.Revision != revision || row.SettledAt != nil {
				return &TodoControlError{Status: 409, Class: "conflict", Code: "stale_attention", Message: "Stack attention changed"}
			}
			now := s.now()
			row.SettledAt = &now
			row.SettledBy = decision.UserID
			row.Actions = []map[string]string{}
			if err := writeStackAttention(ctx, tx, repository, rows); err != nil {
				return err
			}
			_, err = db.New(tx).RequestMythicalStack(ctx, repository)
			return err
		}
		return &TodoControlError{Status: 409, Class: "conflict", Code: "stale_attention", Message: "Stack attention changed"}
	})
}
