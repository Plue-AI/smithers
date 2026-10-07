package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

type stackAttentionEntry struct {
	Key  string `json:"key"`
	Text string `json:"text"`
	Todo int64  `json:"todo"`
}
type stackAttention struct {
	ID        string                `json:"id"`
	Kind      string                `json:"kind"`
	Revision  int64                 `json:"revision"`
	Entries   []stackAttentionEntry `json:"entries"`
	SettledAt *time.Time            `json:"settled_at,omitempty"`
	SettledBy int64                 `json:"settled_by,omitempty"`
}

func readStackAttention(ctx context.Context, conn db.DBTX, repo int64) ([]stackAttention, error) {
	var raw []byte
	err := conn.QueryRow(ctx, `SELECT attention FROM mythical_stacks WHERE repository_id=$1`, repo).Scan(&raw)
	if err == pgx.ErrNoRows {
		return []stackAttention{}, nil
	}
	if err != nil {
		return nil, err
	}
	var rows []stackAttention
	err = json.Unmarshal(raw, &rows)
	return rows, err
}

// The caller holds the stack lock, shared with OK and merge claims.
func appendOrderAttention(ctx context.Context, tx pgx.Tx, repo int64, entry stackAttentionEntry) error {
	rows, err := readStackAttention(ctx, tx, repo)
	if err != nil {
		return err
	}
	index := -1
	for i, row := range rows {
		for _, prior := range row.Entries {
			if prior.Key == entry.Key {
				return nil
			}
		}
		if row.Kind == "order" && row.SettledAt == nil {
			index = i
		}
	}
	if index < 0 {
		rows = append(rows, stackAttention{ID: uuid.NewString(), Kind: "order"})
		index = len(rows) - 1
	}
	rows[index].Entries = append(rows[index].Entries, entry)
	rows[index].Revision++
	raw, err := json.Marshal(rows)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE mythical_stacks SET attention=$2, updated_at=now() WHERE repository_id=$1`, repo, raw)
	return err
}

func stackMergeAttention(ctx context.Context, conn db.DBTX, repo int64) error {
	rows, err := readStackAttention(ctx, conn, repo)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row.SettledAt == nil {
			return mythicalMergeConflict("attention", "Needs you: "+row.ID)
		}
	}
	return nil
}

// StackAttention projects only the audience's open entries. It never exposes
// a maintainer action on a member's Home card.
func (s *MythicalService) StackAttention(ctx context.Context, repo, member int64) ([]map[string]any, error) {
	role, err := InstallRoleOf(ctx, s.queries(), member)
	if err != nil {
		return nil, err
	}
	result := []map[string]any{}
	rows, err := readStackAttention(ctx, s.store, repo)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row.SettledAt != nil || row.Kind == "order" && role != InstallOwner && role != InstallMaintainer || row.Kind == "force_push" && role != InstallOwner {
			continue
		}
		var sentences []string
		for _, entry := range row.Entries {
			sentences = append(sentences, entry.Text)
		}
		actions := []any{}
		if row.Kind == "order" {
			actions = append(actions, map[string]any{"tag": "order.ok", "label": "OK", "args": map[string]string{"id": row.ID, "revision": fmt.Sprint(row.Revision)}})
		}
		result = append(result, map[string]any{"id": row.ID, "revision": row.Revision, "kind": row.Kind, "text": strings.Join(sentences, "\n"), "actions": actions})
	}
	return result, nil
}

// OrderOK serializes the displayed revision with new inbound entries. An old
// press never acknowledges facts that the person has not seen.
func (s *MythicalService) OrderOK(ctx context.Context, repo int64, id string, revision int64) error {
	decision, err := Authorize(ctx, s.queries(), "order.ok")
	if err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repo); err != nil {
			return err
		}
		for _, query := range []string{`SELECT user_id FROM self_host_owners FOR SHARE`, `SELECT user_id FROM collaborators WHERE repository_id=$1 FOR SHARE`} {
			var err error
			if strings.Contains(query, "$1") {
				_, err = tx.Exec(ctx, query, repo)
			} else {
				_, err = tx.Exec(ctx, query)
			}
			if err != nil {
				return err
			}
		}
		if err := lockInstallSessionWrite(ctx, tx, decision.UserID); err != nil {
			return err
		}
		// Re-read roster authority; the route's earlier check is not a write fence.
		role, err := InstallRoleOf(ctx, db.New(tx), decision.UserID)
		if err != nil {
			return err
		}
		if role != InstallOwner && role != InstallMaintainer {
			return &AccessError{Status: 403, Class: "permission", Code: "permission", Message: "Only a maintainer can do this"}
		}
		rows, err := readStackAttention(ctx, tx, repo)
		if err != nil {
			return err
		}
		for i := range rows {
			if rows[i].ID != id || rows[i].Kind != "order" {
				continue
			}
			if rows[i].Revision != revision {
				return &TodoControlError{Status: 409, Code: "stale_attention", Class: "conflict", Message: "The attention changed; review it again"}
			}
			if rows[i].SettledAt != nil {
				return nil
			}
			now := s.now()
			rows[i].SettledAt, rows[i].SettledBy = &now, decision.UserID
			raw, err := json.Marshal(rows)
			if err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `UPDATE mythical_stacks SET attention=$2, updated_at=now() WHERE repository_id=$1`, repo, raw); err != nil {
				return err
			}
			_, err = db.New(tx).RequestMythicalStack(ctx, repo)
			return err
		}
		return &TodoControlError{Status: 404, Code: "attention_not_found", Class: "user", Message: "Attention not found"}
	})
}

// Fence OK against deletion of the admitted person session before the write.
func lockInstallSessionWrite(ctx context.Context, tx pgx.Tx, actorID int64) error {
	info := middleware.AuthInfoFromContext(ctx)
	dead := func() error {
		return &AccessError{Status: 401, Class: "permission", Code: "unauthenticated", Message: "Sign in again"}
	}
	if info == nil || info.User == nil || info.User.ID != actorID || info.IsTokenAuth || info.SessionHash == "" {
		return dead()
	}
	var id int64
	if err := tx.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND is_active AND NOT prohibit_login AND deleted_at IS NULL FOR SHARE`, actorID).Scan(&id); err == pgx.ErrNoRows {
		return dead()
	} else if err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT session_key FROM auth_sessions WHERE user_id=$1 AND expires_at>now()`, actorID)
	if err != nil {
		return err
	}
	key := ""
	for rows.Next() {
		var stored string
		if err = rows.Scan(&stored); err != nil {
			rows.Close()
			return err
		}
		digest := sha256.Sum256([]byte(stored))
		if stored == info.SessionHash || (middleware.LegacyRawSessionKey(stored) && hex.EncodeToString(digest[:]) == info.SessionHash) {
			key = stored
			break
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if key == "" {
		return dead()
	}
	err = tx.QueryRow(ctx, `SELECT session_key FROM auth_sessions WHERE session_key=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE`, key, actorID).Scan(&key)
	if err == pgx.ErrNoRows {
		return dead()
	}
	return err
}
