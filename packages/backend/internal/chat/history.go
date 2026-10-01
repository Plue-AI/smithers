package chat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

const maxHistoryPage = 50

type RunReference struct {
	Repo        string `json:"repo"`
	RunID       string `json:"runId"`
	WorkspaceID string `json:"workspaceId,omitempty"`
}

// Listing is an index, never a transcript, prompt, tool result or capability.
type HistoryTurn struct {
	RunID      string         `json:"runId"`
	LegID      string         `json:"legId"`
	AcceptedAt int64          `json:"acceptedAt"`
	Terminal   bool           `json:"terminal"`
	RunLinks   []RunReference `json:"runLinks"`
}

type Conversation struct {
	ID    string        `json:"id"`
	Turns []HistoryTurn `json:"turns"`
}

type HistoryPage struct {
	Status        string         `json:"status"`
	Conversations []Conversation `json:"conversations"`
	Next          *string        `json:"next"`
}

type historyBoundary struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
}

type AccountReplayInput struct {
	Scope Scope   `json:"-"`
	RunID string  `json:"runId"`
	LegID string  `json:"legId"`
	After *Cursor `json:"after,omitempty"`
}

type AccountReplayResult struct {
	Status         string       `json:"status"`
	ConversationID string       `json:"conversationId"`
	UserText       string       `json:"userText"`
	Page           ReplayResult `json:"page"`
}

func accountHash(scope Scope) (string, error) {
	if scope.UserID <= 0 || !validIdentity(scope.Owner) {
		return "", ErrInvalidRequest
	}
	return digest("owner", []any{"account", scope.Owner})
}

func authorizeAccount(turn turnRecord, ownerHash string) error {
	if turn.OwnerHash == nil || !equalSecret(*turn.OwnerHash, ownerHash) {
		return ErrForbidden
	}
	if turn.State == StateRetired {
		return ErrRetired
	}
	return nil
}

// Only the last visible user message is recovered. Instructions, runtime
// context, assistant history and function-call outputs are not public facts.
func conversationMetadata(turn turnRecord) (string, string, error) {
	value, canonical, err := parseCanonical(turn.Request)
	if err != nil || digestCanonical("request", canonical) != turn.RequestHash {
		return "", "", ErrCorrupt
	}
	request, ok := value.(map[string]any)
	if !ok {
		return "", "", ErrCorrupt
	}
	if purpose, exists := request["purpose"]; exists && purpose != "conversation" {
		return "", "", ErrForbidden
	}
	id := turn.RunID // Older accepted turns have no branch identity.
	if supplied, exists := request["conversationId"]; exists {
		id, ok = supplied.(string)
		if !ok || !validIdentity(id) {
			return "", "", ErrCorrupt
		}
	}
	text := ""
	if messages, ok := request["messages"].([]any); ok {
		for _, value := range messages {
			message, ok := value.(map[string]any)
			if ok && message["role"] == "user" {
				if content, ok := message["content"].(string); ok {
					text = content
				}
			}
		}
	}
	return id, text, nil
}

var historyRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// Pull only identifiers from committed public run cards. No arbitrary payload
// or tool result crosses the index boundary, and the owning run API still
// authorizes the referenced run when it is opened.
func (s *Store) publicRunReferences(ctx context.Context, tx pgx.Tx, turn turnRecord) ([]RunReference, error) {
	acceptance, _, err := checkHead(turn)
	if err != nil {
		return nil, err
	}
	cursor := initialCursor(acceptance)
	unique := make(map[RunReference]struct{})
	for {
		page, err := s.replayVerified(ctx, tx, turn, cursor, maxReplayBatches)
		if err != nil {
			return nil, err
		}
		for _, batch := range page.Batches {
			for _, raw := range batch.Frames {
				var frame struct {
					Type string `json:"type"`
					Card struct {
						Kind    string       `json:"kind"`
						Payload RunReference `json:"payload"`
					} `json:"card"`
				}
				if json.Unmarshal(raw, &frame) != nil {
					return nil, ErrCorrupt
				}
				link := frame.Card.Payload
				if frame.Type != "card" || frame.Card.Kind != "run-trace" || !historyRepo.MatchString(link.Repo) ||
					!validIdentity(link.RunID) || (link.WorkspaceID != "" && !validIdentity(link.WorkspaceID)) {
					continue
				}
				unique[link] = struct{}{}
				// Refuse an oversized index rather than silently lose run doors.
				if len(unique) > 64 {
					return nil, ErrLimit
				}
			}
		}
		if !page.More {
			break
		}
		cursor = page.Next
	}
	links := make([]RunReference, 0, len(unique))
	for link := range unique {
		links = append(links, link)
	}
	sort.Slice(links, func(i, j int) bool {
		if links[i].Repo != links[j].Repo {
			return links[i].Repo < links[j].Repo
		}
		if links[i].RunID != links[j].RunID {
			return links[i].RunID < links[j].RunID
		}
		return links[i].WorkspaceID < links[j].WorkspaceID
	})
	return links, nil
}

// Keyset pagination does not depend on a device token or on a row remaining
// readable between pages (retirement removes accepted_at_ms).
func (s *Store) History(ctx context.Context, scope Scope, after string, limit int) (HistoryPage, error) {
	ownerHash, err := accountHash(scope)
	if err != nil {
		return HistoryPage{}, err
	}
	if limit < 1 || limit > maxHistoryPage {
		return HistoryPage{}, ErrInvalidRequest
	}
	boundary := historyBoundary{CreatedAt: time.Unix(0, 0).UTC()}
	if after != "" {
		if len(after) > 512 {
			return HistoryPage{}, ErrInvalidRequest
		}
		raw, decodeErr := base64.RawURLEncoding.DecodeString(after)
		if decodeErr != nil || json.Unmarshal(raw, &boundary) != nil || !validIdentity(boundary.ID) || boundary.CreatedAt.IsZero() {
			return HistoryPage{}, ErrInvalidRequest
		}
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return HistoryPage{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	rows, err := tx.Query(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE user_id=$1 AND state<>'retired'
		AND COALESCE(request_payload->>'purpose','conversation')='conversation'
		AND (created_at,id)>($2,$3) ORDER BY created_at,id LIMIT $4`, scope.UserID, boundary.CreatedAt, boundary.ID, limit+1)
	if err != nil {
		return HistoryPage{}, err
	}
	turns := make([]turnRecord, 0, limit+1)
	for rows.Next() {
		turn, scanErr := scanTurn(rows)
		if scanErr != nil {
			rows.Close()
			return HistoryPage{}, scanErr
		}
		turns = append(turns, turn)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return HistoryPage{}, err
	}
	page := HistoryPage{Status: "ok", Conversations: make([]Conversation, 0)}
	if len(turns) > limit {
		last := turns[limit-1]
		encoded, _ := json.Marshal(historyBoundary{CreatedAt: last.CreatedAt, ID: last.ID})
		next := base64.RawURLEncoding.EncodeToString(encoded)
		page.Next = &next
		turns = turns[:limit]
	}
	byID := make(map[string]int)
	for _, turn := range turns {
		if err = authorizeAccount(turn, ownerHash); err != nil {
			return HistoryPage{}, err
		}
		if _, _, err = checkHead(turn); err != nil {
			return HistoryPage{}, err
		}
		id, _, metadataErr := conversationMetadata(turn)
		if metadataErr != nil {
			return HistoryPage{}, metadataErr
		}
		links, linkErr := s.publicRunReferences(ctx, tx, turn)
		if linkErr != nil {
			return HistoryPage{}, linkErr
		}
		index, exists := byID[id]
		if !exists {
			index = len(page.Conversations)
			byID[id] = index
			page.Conversations = append(page.Conversations, Conversation{ID: id, Turns: make([]HistoryTurn, 0)})
		}
		page.Conversations[index].Turns = append(page.Conversations[index].Turns, HistoryTurn{
			RunID: turn.RunID, LegID: turn.LegID, AcceptedAt: *turn.AcceptedAtMS, Terminal: turn.Terminal, RunLinks: links,
		})
	}
	if err = tx.Commit(ctx); err != nil {
		return HistoryPage{}, err
	}
	return page, nil
}

func (s *Store) ReplayAccount(ctx context.Context, input AccountReplayInput) (AccountReplayResult, error) {
	if !validIdentity(input.RunID) || !validIdentity(input.LegID) || (input.After != nil && !validCursor(*input.After)) {
		return AccountReplayResult{}, ErrInvalidRequest
	}
	ownerHash, err := accountHash(input.Scope)
	if err != nil {
		return AccountReplayResult{}, err
	}
	turn, err := scanTurn(s.pool.QueryRow(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3`, input.Scope.UserID, input.RunID, input.LegID))
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountReplayResult{}, ErrNotFound
	}
	if err != nil {
		return AccountReplayResult{}, err
	}
	if err = authorizeAccount(turn, ownerHash); err != nil {
		return AccountReplayResult{}, err
	}
	id, text, err := conversationMetadata(turn)
	if err != nil {
		return AccountReplayResult{}, err
	}
	// No output is returned unless the shared verifier subsequently confirms
	// this account's readable committed prefix. A racing retirement refuses it.
	page, err := s.replay(ctx, input.Scope, input.RunID, input.LegID, input.After, 8, ownerHash, nil)
	if err != nil {
		return AccountReplayResult{}, err
	}
	return AccountReplayResult{Status: "ok", ConversationID: id, UserText: text, Page: page}, nil
}
