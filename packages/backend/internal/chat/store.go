package chat

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/buildcache"
)

const (
	maxPayloadBytes = 2 << 20
	maxBatchFrames  = 256
	maxBatchBytes   = 96 << 10
	maxOutputBytes  = 8 << 20
	// The producer commits one frame per batch, so a batch count cap must not
	// bind before the byte budget. No valid batch encodes below 192 bytes.
	maxBatches       = maxOutputBytes / 192
	maxReplayBatches = 16
	// A terminal batch repeats runId in its envelope and frame and legId in
	// its envelope. JSON escapes a control byte to six bytes, so two
	// 160-byte identities can cost about 3 KB before the frame itself.
	terminalReserveBytes = 4096
	maxIdentityBytes     = 160
	maxSafeInteger       = int64(1<<53 - 1)
)

var (
	journalTokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{32,128}$`)
	hexHashPattern      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

//go:embed schema.sql
var schemaFS embed.FS

func Schema() ([]byte, error) { return schemaFS.ReadFile("schema.sql") }

type Store struct {
	pool    *pgxpool.Pool
	now     func() time.Time
	signals turnSignals
	// afterReplayHead is a test seam that runs between the head read and the
	// batch reads of Replay.
	afterReplayHead func()
}

func NewStore(pool *pgxpool.Pool) (*Store, error) {
	if pool == nil {
		return nil, errors.New("chat store requires a PostgreSQL pool")
	}
	return &Store{pool: pool, now: time.Now}, nil
}

func validIdentity(value string) bool {
	return value != "" && len(value) <= maxIdentityBytes && utf8.ValidString(value)
}

func validJournal(value JournalRequest) bool {
	return value.Version == 1 && validIdentity(value.LegID) && journalTokenPattern.MatchString(value.Token)
}

func validCursor(value Cursor) bool {
	return value.Version == 1 && validIdentity(value.RunID) && validIdentity(value.LegID) &&
		value.Batch >= 0 && value.Batch <= maxSafeInteger && value.Position >= 0 && value.Position <= maxSafeInteger &&
		hexHashPattern.MatchString(value.Hash)
}

func parseCanonical(raw []byte) (any, string, error) {
	if len(raw) == 0 || len(raw) > maxPayloadBytes || !utf8.Valid(raw) {
		return nil, "", ErrInvalidRequest
	}
	value, err := buildcache.ParseJSON(string(raw))
	if err != nil {
		return nil, "", ErrInvalidRequest
	}
	canonical, err := buildcache.CanonicalJSON(value)
	if err != nil {
		return nil, "", ErrInvalidRequest
	}
	return value, canonical, nil
}

func canonicalValue(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	parsed, _, err := parseCanonical(raw)
	if err != nil {
		return "", err
	}
	return buildcache.CanonicalJSON(parsed)
}

func digest(kind string, value any) (string, error) {
	canonical, err := canonicalValue(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte("smithers-agent-turn/" + kind + "/v1:" + canonical))
	return hex.EncodeToString(sum[:]), nil
}

func digestCanonical(kind, canonical string) string {
	sum := sha256.Sum256([]byte("smithers-agent-turn/" + kind + "/v1:" + canonical))
	return hex.EncodeToString(sum[:])
}

func hashToken(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func tokenPair() (string, string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", "", err
	}
	plain := base64.RawURLEncoding.EncodeToString(raw[:])
	return plain, hashToken(plain), nil
}

func equalSecret(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

// Lock the public turn identity across admission and proof-only erasure. The
// lock exists even before a turn row does, which closes the preacceptance race.
func lockTurnIdentity(ctx context.Context, tx pgx.Tx, runID, legID string) error {
	sum := sha256.Sum256([]byte(runID + "\x00" + legID))
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(sum[:8])))
	return err
}

type acceptanceUnsigned struct {
	Version     int     `json:"version"`
	RunID       string  `json:"runId"`
	LegID       string  `json:"legId"`
	OwnerHash   string  `json:"ownerHash"`
	AccessHash  string  `json:"accessHash"`
	RequestHash string  `json:"requestHash"`
	WriterHash  string  `json:"writerHash"`
	AcceptedAt  float64 `json:"acceptedAt"`
}

type batchUnsigned struct {
	Version      int               `json:"version"`
	RunID        string            `json:"runId"`
	LegID        string            `json:"legId"`
	Batch        int64             `json:"batch"`
	From         int64             `json:"from"`
	PreviousHash string            `json:"previousHash"`
	Frames       []json.RawMessage `json:"frames"`
}

type headUnsigned struct {
	Version    int        `json:"version"`
	Acceptance Acceptance `json:"acceptance"`
	Cursor     Cursor     `json:"cursor"`
	Bytes      int64      `json:"bytes"`
	Terminal   bool       `json:"terminal"`
}

type retirementUnsigned struct {
	Version        int     `json:"version"`
	Retired        bool    `json:"retired"`
	RunID          string  `json:"runId"`
	LegID          string  `json:"legId"`
	OwnerHash      *string `json:"ownerHash"`
	AccessHash     string  `json:"accessHash"`
	AcceptanceHash *string `json:"acceptanceHash"`
	Batches        int64   `json:"batches"`
	ErasedBatches  int64   `json:"erasedBatches"`
	RetiredAt      float64 `json:"retiredAt"`
}

type retirement struct {
	retirementUnsigned
	Hash string `json:"hash"`
}

func makeAcceptance(runID, legID, ownerHash, accessHash, requestHash, writerHash string, acceptedAt int64) (Acceptance, error) {
	body := acceptanceUnsigned{Version: 1, RunID: runID, LegID: legID, OwnerHash: ownerHash, AccessHash: accessHash, RequestHash: requestHash, WriterHash: writerHash, AcceptedAt: float64(acceptedAt)}
	hash, err := digest("acceptance", body)
	if err != nil {
		return Acceptance{}, err
	}
	return Acceptance{Version: body.Version, RunID: body.RunID, LegID: body.LegID, OwnerHash: body.OwnerHash, AccessHash: body.AccessHash, RequestHash: body.RequestHash, WriterHash: body.WriterHash, AcceptedAt: body.AcceptedAt, Hash: hash}, nil
}

func acceptanceBody(value Acceptance) acceptanceUnsigned {
	return acceptanceUnsigned{Version: value.Version, RunID: value.RunID, LegID: value.LegID, OwnerHash: value.OwnerHash, AccessHash: value.AccessHash, RequestHash: value.RequestHash, WriterHash: value.WriterHash, AcceptedAt: value.AcceptedAt}
}

func makeBatch(expected Cursor, frames []json.RawMessage) (Batch, int, error) {
	body := batchUnsigned{Version: 1, RunID: expected.RunID, LegID: expected.LegID, Batch: expected.Batch + 1, From: expected.Position + 1, PreviousHash: expected.Hash, Frames: frames}
	hash, err := digest("batch", body)
	if err != nil {
		return Batch{}, 0, err
	}
	batch := Batch{Version: body.Version, RunID: body.RunID, LegID: body.LegID, Batch: body.Batch, From: body.From, PreviousHash: body.PreviousHash, Frames: frames, Hash: hash}
	canonical, err := canonicalValue(batch)
	if err != nil {
		return Batch{}, 0, err
	}
	return batch, len([]byte(canonical)), nil
}

func batchBody(value Batch) batchUnsigned {
	return batchUnsigned{Version: value.Version, RunID: value.RunID, LegID: value.LegID, Batch: value.Batch, From: value.From, PreviousHash: value.PreviousHash, Frames: value.Frames}
}

func cursorAfter(batch Batch) Cursor {
	return Cursor{Version: 1, RunID: batch.RunID, LegID: batch.LegID, Batch: batch.Batch, Position: batch.From + int64(len(batch.Frames)) - 1, Hash: batch.Hash}
}

func sameCursor(left, right Cursor) bool {
	return left.Version == right.Version && left.RunID == right.RunID && left.LegID == right.LegID && left.Batch == right.Batch && left.Position == right.Position && equalSecret(left.Hash, right.Hash)
}

func initialCursor(acceptance Acceptance) Cursor {
	return Cursor{Version: 1, RunID: acceptance.RunID, LegID: acceptance.LegID, Hash: acceptance.Hash}
}

func headHash(acceptance Acceptance, cursor Cursor, bytes int64, terminal bool) (string, error) {
	return digest("head", headUnsigned{Version: 1, Acceptance: acceptance, Cursor: cursor, Bytes: bytes, Terminal: terminal})
}

type turnRecord struct {
	ID                     string
	RepositoryID           int64
	UserID                 int64
	RunID                  string
	LegID                  string
	Request                json.RawMessage
	RequestHash            string
	OwnerHash              *string
	AccessHash             string
	WriterHash             *string
	AcceptanceJSON         json.RawMessage
	AcceptanceHash         *string
	AcceptedAtMS           *int64
	HeadBatch              int64
	HeadPosition           int64
	CursorHash             *string
	HeadHash               *string
	OutputBytes            int64
	Terminal               bool
	State                  State
	ProducerGeneration     int64
	ProducerTokenHash      *string
	ProducerLeaseExpiresAt *time.Time
	ProducerStartedAt      *time.Time
	CancelRequestedAt      *time.Time
	Retirement             json.RawMessage
	CreatedAt              time.Time
	UpdatedAt              time.Time
}

const turnColumns = `id,repository_id,user_id,run_id,leg_id,request_payload,request_hash,owner_hash,access_hash,writer_hash,acceptance,acceptance_hash,accepted_at_ms,head_batch,head_position,cursor_hash,head_hash,output_bytes,terminal,state,producer_generation,producer_token_hash,producer_lease_expires_at,producer_started_at,cancel_requested_at,retirement,created_at,updated_at`

type scanner interface{ Scan(...any) error }

type journalQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

func scanTurn(row scanner) (turnRecord, error) {
	var value turnRecord
	err := row.Scan(&value.ID, &value.RepositoryID, &value.UserID, &value.RunID, &value.LegID, &value.Request, &value.RequestHash,
		&value.OwnerHash, &value.AccessHash, &value.WriterHash, &value.AcceptanceJSON, &value.AcceptanceHash, &value.AcceptedAtMS,
		&value.HeadBatch, &value.HeadPosition, &value.CursorHash, &value.HeadHash, &value.OutputBytes, &value.Terminal, &value.State,
		&value.ProducerGeneration, &value.ProducerTokenHash, &value.ProducerLeaseExpiresAt, &value.ProducerStartedAt,
		&value.CancelRequestedAt, &value.Retirement, &value.CreatedAt, &value.UpdatedAt)
	return value, err
}

func acceptanceOf(turn turnRecord) (Acceptance, error) {
	if turn.State == StateRetired {
		return Acceptance{}, ErrRetired
	}
	if len(turn.AcceptanceJSON) == 0 || turn.AcceptanceHash == nil || turn.OwnerHash == nil || turn.WriterHash == nil || turn.AcceptedAtMS == nil {
		return Acceptance{}, ErrCorrupt
	}
	var acceptance Acceptance
	if err := json.Unmarshal(turn.AcceptanceJSON, &acceptance); err != nil {
		return Acceptance{}, ErrCorrupt
	}
	hash, err := digest("acceptance", acceptanceBody(acceptance))
	if err != nil || !hexHashPattern.MatchString(acceptance.Hash) || !equalSecret(hash, acceptance.Hash) || !equalSecret(acceptance.Hash, *turn.AcceptanceHash) ||
		acceptance.RunID != turn.RunID || acceptance.LegID != turn.LegID || acceptance.OwnerHash != *turn.OwnerHash || acceptance.AccessHash != turn.AccessHash ||
		acceptance.RequestHash != turn.RequestHash || acceptance.WriterHash != *turn.WriterHash || int64(acceptance.AcceptedAt) != *turn.AcceptedAtMS {
		return Acceptance{}, ErrCorrupt
	}
	return acceptance, nil
}

func cursorOf(turn turnRecord) (Cursor, error) {
	acceptance, err := acceptanceOf(turn)
	if err != nil {
		return Cursor{}, err
	}
	if turn.CursorHash == nil {
		return Cursor{}, ErrCorrupt
	}
	cursor := Cursor{Version: 1, RunID: turn.RunID, LegID: turn.LegID, Batch: turn.HeadBatch, Position: turn.HeadPosition, Hash: *turn.CursorHash}
	if cursor.Batch == 0 && !sameCursor(cursor, initialCursor(acceptance)) {
		return Cursor{}, ErrCorrupt
	}
	return cursor, nil
}

func checkHead(turn turnRecord) (Acceptance, Cursor, error) {
	acceptance, err := acceptanceOf(turn)
	if err != nil {
		return Acceptance{}, Cursor{}, err
	}
	if turn.State == StateRetired || turn.Terminal != turn.State.Terminal() {
		return Acceptance{}, Cursor{}, ErrCorrupt
	}
	cursor, err := cursorOf(turn)
	if err != nil || turn.HeadHash == nil {
		return Acceptance{}, Cursor{}, ErrCorrupt
	}
	if !hexHashPattern.MatchString(cursor.Hash) || !hexHashPattern.MatchString(*turn.HeadHash) ||
		cursor.Batch < 0 || cursor.Batch > maxBatches+1 || cursor.Position < cursor.Batch ||
		(cursor.Batch == 0 && (cursor.Position != 0 || !equalSecret(cursor.Hash, acceptance.Hash) || turn.OutputBytes != 0 || turn.Terminal)) {
		return Acceptance{}, Cursor{}, ErrCorrupt
	}
	hash, err := headHash(acceptance, cursor, turn.OutputBytes, turn.Terminal)
	if err != nil || !equalSecret(hash, *turn.HeadHash) {
		return Acceptance{}, Cursor{}, ErrCorrupt
	}
	return acceptance, cursor, nil
}

func authHashes(scope Scope, token string) (string, string, error) {
	if scope.UserID <= 0 || !validIdentity(scope.Owner) || !journalTokenPattern.MatchString(token) {
		return "", "", ErrInvalidRequest
	}
	ownerHash, err := digest("owner", []any{"account", scope.Owner})
	if err != nil {
		return "", "", err
	}
	accessHash, err := digest("access", token)
	return ownerHash, accessHash, err
}

func authorize(turn turnRecord, ownerHash, accessHash string) error {
	if turn.OwnerHash == nil || !equalSecret(*turn.OwnerHash, ownerHash) || !equalSecret(turn.AccessHash, accessHash) {
		return ErrForbidden
	}
	if turn.State == StateRetired {
		return ErrRetired
	}
	return nil
}

func (s *Store) Admit(ctx context.Context, input AdmitInput) (AdmitResult, error) {
	if !validIdentity(input.RunID) || !validJournal(input.Journal) {
		return AdmitResult{}, ErrInvalidRequest
	}
	value, canonical, err := parseCanonical(input.Request)
	if err != nil {
		return AdmitResult{}, err
	}
	if request, ok := value.(map[string]any); ok {
		if supplied, exists := request["conversationId"]; exists {
			id, valid := supplied.(string)
			if !valid || !validIdentity(id) {
				return AdmitResult{}, ErrInvalidRequest
			}
		}
	}
	requestHash := digestCanonical("request", canonical)
	ownerHash, accessHash, err := authHashes(input.Scope, input.Journal.Token)
	if err != nil {
		return AdmitResult{}, err
	}
	writerHash, err := digest("writer", uuid.NewString())
	if err != nil {
		return AdmitResult{}, err
	}
	now := s.now().UTC()
	acceptance, err := makeAcceptance(input.RunID, input.Journal.LegID, ownerHash, accessHash, requestHash, writerHash, now.UnixMilli())
	if err != nil {
		return AdmitResult{}, err
	}
	cursor := initialCursor(acceptance)
	hash, err := headHash(acceptance, cursor, 0, false)
	if err != nil {
		return AdmitResult{}, err
	}
	acceptanceJSON, err := json.Marshal(acceptance)
	if err != nil {
		return AdmitResult{}, err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AdmitResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err = lockTurnIdentity(ctx, tx, input.RunID, input.Journal.LegID); err != nil {
		return AdmitResult{}, err
	}
	// A tombstone fences only the proof that wrote it; other accounts admit
	// the same public identity under their own replay token.
	var erased bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chat_turn_erasures WHERE run_id=$1 AND leg_id=$2 AND access_hash=$3)`, input.RunID, input.Journal.LegID, accessHash).Scan(&erased)
	if err != nil {
		return AdmitResult{}, err
	}
	if erased {
		return AdmitResult{}, ErrRetired
	}
	turnID := uuid.NewString()
	result, err := tx.Exec(ctx, `INSERT INTO chat_turns(
		id,repository_id,user_id,run_id,leg_id,request_payload,request_hash,owner_hash,access_hash,writer_hash,acceptance,acceptance_hash,accepted_at_ms,
		head_batch,head_position,cursor_hash,head_hash,output_bytes,terminal,state,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,0,0,$12,$14,0,false,'accepted',$15,$15)
		ON CONFLICT(user_id,run_id,leg_id) DO NOTHING`, turnID, input.Scope.RepositoryID, input.Scope.UserID, input.RunID, input.Journal.LegID,
		json.RawMessage(canonical), requestHash, ownerHash, accessHash, writerHash, acceptanceJSON, acceptance.Hash, now.UnixMilli(), hash, now)
	if err != nil {
		return AdmitResult{}, err
	}
	if result.RowsAffected() == 0 {
		turn, readErr := scanTurn(tx.QueryRow(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3 FOR UPDATE`, input.Scope.UserID, input.RunID, input.Journal.LegID))
		if readErr != nil {
			return AdmitResult{}, readErr
		}
		if authErr := authorize(turn, ownerHash, accessHash); authErr != nil {
			return AdmitResult{}, authErr
		}
		if !equalSecret(turn.RequestHash, requestHash) {
			return AdmitResult{}, ErrConflict
		}
		_, existing, checkErr := checkHead(turn)
		if checkErr != nil {
			return AdmitResult{}, checkErr
		}
		if err = tx.Commit(ctx); err != nil {
			return AdmitResult{}, err
		}
		return AdmitResult{Status: "existing", Cursor: existing, Terminal: turn.Terminal, TurnID: turn.ID}, nil
	}
	if err = tx.Commit(ctx); err != nil {
		return AdmitResult{}, err
	}
	return AdmitResult{Status: "accepted", Cursor: cursor, Terminal: false, TurnID: turnID}, nil
}

func (s *Store) Claim(ctx context.Context, scope Scope, turnID string, lease time.Duration) (ProducerGrant, error) {
	if scope.UserID <= 0 || turnID == "" || lease <= 0 {
		return ProducerGrant{}, ErrInvalidRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ProducerGrant{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	turn, err := scanTurn(tx.QueryRow(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE id=$1 AND user_id=$2 FOR UPDATE`, turnID, scope.UserID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ProducerGrant{}, ErrNotFound
	}
	if err != nil {
		return ProducerGrant{}, err
	}
	if turn.State == StateRetired {
		return ProducerGrant{}, ErrRetired
	}
	if turn.Terminal || turn.State.Terminal() {
		return ProducerGrant{}, ErrTerminal
	}
	_, cursor, err := checkHead(turn)
	if err != nil {
		return ProducerGrant{}, err
	}
	now := s.now().UTC()
	if turn.ProducerLeaseExpiresAt != nil && turn.ProducerLeaseExpiresAt.After(now) {
		return ProducerGrant{}, ErrProducerBusy
	}
	if turn.ProducerStartedAt != nil {
		frame := errorFrame(turn.RunID, "The model host stopped before completing the turn.")
		if err = s.appendTerminalTx(ctx, tx, &turn, frame, StateUncertain, now); err != nil {
			return ProducerGrant{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return ProducerGrant{}, err
		}
		s.signals.notify(turn.ID)
		return ProducerGrant{}, ErrUncertain
	}
	token, tokenHash, err := tokenPair()
	if err != nil {
		return ProducerGrant{}, err
	}
	generation := turn.ProducerGeneration + 1
	expiresAt := now.Add(lease)
	if _, err = tx.Exec(ctx, `UPDATE chat_turns SET state='running',producer_generation=$2,producer_token_hash=$3,producer_lease_expires_at=$4,producer_started_at=NULL,updated_at=$5 WHERE id=$1`, turn.ID, generation, tokenHash, expiresAt, now); err != nil {
		return ProducerGrant{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ProducerGrant{}, err
	}
	return ProducerGrant{TurnID: turn.ID, OwnerID: turn.UserID, RepositoryID: turn.RepositoryID, RunID: turn.RunID, LegID: turn.LegID,
		Generation: generation, Token: token, Cursor: cursor, ExpiresAt: expiresAt, Request: turn.Request}, nil
}

func (s *Store) MarkProviderStarted(ctx context.Context, grant ProducerGrant) error {
	now := s.now().UTC()
	result, err := s.pool.Exec(ctx, `UPDATE chat_turns SET producer_started_at=COALESCE(producer_started_at,$4),updated_at=$4
		WHERE id=$1 AND producer_generation=$2 AND producer_token_hash=$3 AND state='running' AND producer_lease_expires_at>$4`,
		grant.TurnID, grant.Generation, hashToken(grant.Token), now)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrProducerFenced
	}
	return nil
}

// RenewProducer extends a live producer's lease. It is fenced by generation
// and token, so a producer that lost its claim cannot take the turn back.
func (s *Store) RenewProducer(ctx context.Context, grant ProducerGrant, lease time.Duration) (time.Time, error) {
	if lease <= 0 {
		return time.Time{}, ErrInvalidRequest
	}
	expiresAt := s.now().UTC().Add(lease)
	result, err := s.pool.Exec(ctx, `UPDATE chat_turns SET producer_lease_expires_at=$4
		WHERE id=$1 AND producer_generation=$2 AND producer_token_hash=$3 AND state='running' AND NOT terminal`,
		grant.TurnID, grant.Generation, hashToken(grant.Token), expiresAt)
	if err != nil {
		return time.Time{}, err
	}
	if result.RowsAffected() != 1 {
		return time.Time{}, ErrProducerFenced
	}
	return expiresAt, nil
}

// ReleaseProducer ends the lease of a producer that stopped without a terminal
// fact, such as a process shutdown. Recovery can then reclaim the turn at once;
// Claim decides from producer_started_at whether to rerun it or seal it
// uncertain.
func (s *Store) ReleaseProducer(ctx context.Context, grant ProducerGrant) error {
	result, err := s.pool.Exec(ctx, `UPDATE chat_turns SET producer_lease_expires_at=$4
		WHERE id=$1 AND producer_generation=$2 AND producer_token_hash=$3 AND state='running' AND NOT terminal`,
		grant.TurnID, grant.Generation, hashToken(grant.Token), s.now().UTC())
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrProducerFenced
	}
	return nil
}

// ProducerTurn is the turn a live producer capability names.
type ProducerTurn struct {
	Scope
	RunID string
	LegID string
}

// Producer resolves a producer capability to its turn. Only the current
// generation of a running turn with a live lease and no pending cancel
// passes, so a host tool call ends with its turn.
func (s *Store) Producer(ctx context.Context, turnID string, generation int64, token string) (ProducerTurn, error) {
	if _, err := uuid.Parse(turnID); err != nil || generation <= 0 || token == "" {
		return ProducerTurn{}, ErrProducerFenced
	}
	var turn ProducerTurn
	err := s.pool.QueryRow(ctx, `SELECT user_id,repository_id,run_id,leg_id FROM chat_turns
		WHERE id=$1 AND producer_generation=$2 AND producer_token_hash=$3 AND state='running' AND NOT terminal
		AND cancel_requested_at IS NULL AND producer_lease_expires_at>$4`,
		turnID, generation, hashToken(token), s.now().UTC()).Scan(&turn.UserID, &turn.RepositoryID, &turn.RunID, &turn.LegID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ProducerTurn{}, ErrProducerFenced
	}
	return turn, err
}

type frameMeta struct {
	RunID  string
	Type   string
	Reason string
	Error  string
}

func stringField(value map[string]any, name string, required bool) (string, bool) {
	raw, exists := value[name]
	if !exists {
		return "", !required
	}
	text, ok := raw.(string)
	return text, ok
}

func objectField(value map[string]any, name string, required bool) (map[string]any, bool) {
	raw, exists := value[name]
	if !exists {
		return nil, !required
	}
	object, ok := raw.(map[string]any)
	return object, ok
}

func integerField(value map[string]any, name string, positive bool) bool {
	raw, exists := value[name]
	if !exists {
		return false
	}
	number, ok := raw.(json.Number)
	if !ok {
		return false
	}
	parsed, err := number.Float64()
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed || parsed < 0 || parsed > 9007199254740991 {
		return false
	}
	return !positive || parsed > 0
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func validateFrames(frames []json.RawMessage, expectedRunID string) (frameMeta, error) {
	if len(frames) == 0 || len(frames) > maxBatchFrames {
		return frameMeta{}, ErrInvalidFrame
	}
	var last frameMeta
	for index, raw := range frames {
		if len(raw) == 0 || len(raw) > maxPayloadBytes {
			return frameMeta{}, ErrInvalidFrame
		}
		parsed, _, err := parseCanonical(raw)
		if err != nil {
			return frameMeta{}, ErrInvalidFrame
		}
		object, ok := parsed.(map[string]any)
		if !ok {
			return frameMeta{}, ErrInvalidFrame
		}
		runID, ok := stringField(object, "runId", true)
		if !ok || runID != expectedRunID {
			return frameMeta{}, ErrInvalidFrame
		}
		kind, ok := stringField(object, "type", true)
		if !ok {
			return frameMeta{}, ErrInvalidFrame
		}
		last = frameMeta{RunID: runID, Type: kind}
		switch kind {
		case "delta":
			deltaKind, validKind := stringField(object, "kind", true)
			_, validText := stringField(object, "text", true)
			if !validKind || (deltaKind != "text" && deltaKind != "reasoning") || !validText {
				return frameMeta{}, ErrInvalidFrame
			}
		case "tool_call":
			_, validCall := stringField(object, "call_id", true)
			_, validName := stringField(object, "name", true)
			_, validArguments := stringField(object, "arguments", true)
			if !validCall || !validName || !validArguments {
				return frameMeta{}, ErrInvalidFrame
			}
		case "card":
			if _, valid := objectField(object, "card", true); !valid {
				return frameMeta{}, ErrInvalidFrame
			}
		case "card.update":
			_, validID := stringField(object, "id", true)
			_, validPatch := objectField(object, "patch", true)
			if !validID || !validPatch {
				return frameMeta{}, ErrInvalidFrame
			}
		case "link.authored":
			_, validDigest := stringField(object, "scriptDigest", true)
			_, validScript := stringField(object, "script", true)
			if !integerField(object, "link", false) || !validDigest || !validScript {
				return frameMeta{}, ErrInvalidFrame
			}
		case "call.started":
			_, validName := stringField(object, "name", true)
			if !integerField(object, "link", false) || !integerField(object, "ordinal", false) || !validName {
				return frameMeta{}, ErrInvalidFrame
			}
		case "call.settled":
			_, validName := stringField(object, "name", true)
			verdict, validVerdict := stringField(object, "verdict", true)
			_, validDigest := stringField(object, "resultDigest", false)
			if !integerField(object, "link", false) || !integerField(object, "ordinal", false) || !validName ||
				!validVerdict || !oneOf(verdict, "run", "hit", "replay") || !validDigest {
				return frameMeta{}, ErrInvalidFrame
			}
		case "gate.rejected":
			kind, validKind := stringField(object, "kind", true)
			_, validMessage := stringField(object, "message", false)
			if !integerField(object, "link", false) || !validKind ||
				!oneOf(kind, "shape", "fuel", "catalog", "denied", "call_failed", "script_failed") || !validMessage {
				return frameMeta{}, ErrInvalidFrame
			}
		case "link.ended":
			outcome, validOutcome := stringField(object, "outcome", true)
			if !integerField(object, "link", false) || !validOutcome || !oneOf(outcome, "done", "to", "park") {
				return frameMeta{}, ErrInvalidFrame
			}
		case "steering.drained":
			if !integerField(object, "link", false) || !integerField(object, "count", true) {
				return frameMeta{}, ErrInvalidFrame
			}
		case "park":
			code, validCode := stringField(object, "code", true)
			_, validCard := objectField(object, "card", false)
			if !validCode || !oneOf(code, "approval", "event", "timer", "quota", "plugin") || !validCard {
				return frameMeta{}, ErrInvalidFrame
			}
		case "done":
			if index != len(frames)-1 {
				return frameMeta{}, ErrInvalidFrame
			}
			if reason, exists := object["reason"]; exists {
				text, valid := reason.(string)
				if !valid || (text != "stop" && text != "tool_call" && text != "tool_limit" && text != "cancelled") {
					return frameMeta{}, ErrInvalidFrame
				}
				last.Reason = text
			}
			if failure, exists := object["error"]; exists {
				text, valid := failure.(string)
				if !valid {
					return frameMeta{}, ErrInvalidFrame
				}
				last.Error = text
			}
		default:
			return frameMeta{}, ErrInvalidFrame
		}
	}
	return last, nil
}

func terminalState(meta frameMeta) State {
	if meta.Type != "done" {
		return StateRunning
	}
	if meta.Reason == "cancelled" {
		return StateCancelled
	}
	if meta.Error != "" {
		return StateFailed
	}
	return StateCompleted
}

func loadBatch(row scanner) (Batch, int, error) {
	var batch Batch
	var frames json.RawMessage
	var bytes int
	if err := row.Scan(&batch.Batch, &batch.From, &batch.PreviousHash, &frames, &batch.Hash, &bytes); err != nil {
		return Batch{}, 0, err
	}
	if err := json.Unmarshal(frames, &batch.Frames); err != nil {
		return Batch{}, 0, ErrCorrupt
	}
	batch.Version = 1
	return batch, bytes, nil
}

func verifyStoredBatch(turn turnRecord, number int64, batch Batch, storedBytes int) (Batch, frameMeta, error) {
	batch.RunID, batch.LegID = turn.RunID, turn.LegID
	if batch.Batch != number || batch.From <= 0 || !hexHashPattern.MatchString(batch.PreviousHash) || !hexHashPattern.MatchString(batch.Hash) {
		return Batch{}, frameMeta{}, ErrCorrupt
	}
	hash, err := digest("batch", batchBody(batch))
	if err != nil || !equalSecret(hash, batch.Hash) {
		return Batch{}, frameMeta{}, ErrCorrupt
	}
	canonical, err := canonicalValue(batch)
	if err != nil || storedBytes != len([]byte(canonical)) {
		return Batch{}, frameMeta{}, ErrCorrupt
	}
	meta, err := validateFrames(batch.Frames, turn.RunID)
	if err != nil {
		return Batch{}, frameMeta{}, ErrCorrupt
	}
	return batch, meta, nil
}

func (s *Store) Commit(ctx context.Context, input CommitInput) (CommitResult, error) {
	if input.TurnID == "" || input.Generation <= 0 || input.Token == "" || !validCursor(input.Expected) {
		return CommitResult{}, ErrInvalidRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CommitResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	turn, err := scanTurn(tx.QueryRow(ctx, `SELECT /* smithers-chat-commit-head */ `+turnColumns+` FROM chat_turns WHERE id=$1 FOR UPDATE`, input.TurnID))
	if errors.Is(err, pgx.ErrNoRows) {
		return CommitResult{}, ErrNotFound
	}
	if err != nil {
		return CommitResult{}, err
	}
	if turn.ProducerGeneration != input.Generation || turn.ProducerTokenHash == nil || !equalSecret(*turn.ProducerTokenHash, hashToken(input.Token)) {
		return CommitResult{}, ErrProducerFenced
	}
	_, head, err := checkHead(turn)
	if err != nil {
		return CommitResult{}, err
	}
	if input.Expected.RunID != turn.RunID || input.Expected.LegID != turn.LegID {
		return CommitResult{}, ErrCursorConflict
	}
	meta, err := validateFrames(input.Frames, turn.RunID)
	if err != nil {
		return CommitResult{}, err
	}
	batch, batchBytes, err := makeBatch(input.Expected, input.Frames)
	if err != nil {
		return CommitResult{}, err
	}
	if input.Expected.Batch < head.Batch {
		stored, storedBytes, readErr := loadBatch(tx.QueryRow(ctx, `SELECT batch_number,from_position,previous_hash,frames,hash,canonical_bytes FROM chat_turn_batches WHERE turn_id=$1 AND batch_number=$2`, turn.ID, batch.Batch))
		if errors.Is(readErr, pgx.ErrNoRows) {
			return CommitResult{}, ErrCursorConflict
		}
		if readErr != nil {
			return CommitResult{}, readErr
		}
		stored, _, readErr = verifyStoredBatch(turn, batch.Batch, stored, storedBytes)
		if readErr != nil {
			return CommitResult{}, readErr
		}
		if !equalSecret(stored.Hash, batch.Hash) {
			return CommitResult{}, ErrConflict
		}
		if err = tx.Commit(ctx); err != nil {
			return CommitResult{}, err
		}
		return CommitResult{Status: "duplicate", Batch: stored, Cursor: cursorAfter(stored)}, nil
	}
	if !sameCursor(input.Expected, head) {
		return CommitResult{}, ErrCursorConflict
	}
	if turn.Terminal {
		return CommitResult{}, ErrTerminal
	}
	now := s.now().UTC()
	if turn.ProducerLeaseExpiresAt == nil || !turn.ProducerLeaseExpiresAt.After(now) {
		return CommitResult{}, ErrProducerFenced
	}
	terminal := meta.Type == "done"
	terminalReserve := terminal && len(input.Frames) == 1 && batchBytes <= terminalReserveBytes
	if batchBytes > maxBatchBytes || ((!terminalReserve && (turn.OutputBytes+int64(batchBytes) > maxOutputBytes || batch.Batch > maxBatches)) || batch.Batch > maxBatches+1) {
		return CommitResult{}, ErrLimit
	}
	framesJSON, err := json.Marshal(batch.Frames)
	if err != nil {
		return CommitResult{}, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO chat_turn_batches(turn_id,batch_number,from_position,previous_hash,frames,hash,canonical_bytes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		turn.ID, batch.Batch, batch.From, batch.PreviousHash, framesJSON, batch.Hash, batchBytes, now); err != nil {
		return CommitResult{}, err
	}
	next := cursorAfter(batch)
	nextBytes := turn.OutputBytes + int64(batchBytes)
	nextState := terminalState(meta)
	acceptance, err := acceptanceOf(turn)
	if err != nil {
		return CommitResult{}, err
	}
	nextHeadHash, err := headHash(acceptance, next, nextBytes, terminal)
	if err != nil {
		return CommitResult{}, err
	}
	if _, err = tx.Exec(ctx, `UPDATE chat_turns SET head_batch=$2,head_position=$3,cursor_hash=$4,head_hash=$5,output_bytes=$6,terminal=$7,state=$8,
		producer_lease_expires_at=CASE WHEN $7 THEN NULL ELSE producer_lease_expires_at END,updated_at=$9 WHERE id=$1`,
		turn.ID, next.Batch, next.Position, next.Hash, nextHeadHash, nextBytes, terminal, nextState, now); err != nil {
		return CommitResult{}, err
	}
	if err = notifyTx(ctx, tx, turn.ID); err != nil {
		return CommitResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return CommitResult{}, err
	}
	s.signals.notify(turn.ID)
	return CommitResult{Status: "committed", Batch: batch, Cursor: next}, nil
}

func (s *Store) replayVerified(ctx context.Context, query journalQuerier, turn turnRecord, after Cursor, limit int) (ReplayResult, error) {
	acceptance, head, err := checkHead(turn)
	if err != nil {
		return ReplayResult{}, err
	}
	baseline := initialCursor(acceptance)
	if after.RunID != turn.RunID || after.LegID != turn.LegID || after.Batch < 0 || after.Batch > head.Batch {
		return ReplayResult{}, ErrCursorConflict
	}
	if after.Batch == 0 {
		if !sameCursor(after, baseline) {
			return ReplayResult{}, ErrCursorConflict
		}
	} else {
		boundary, storedBytes, readErr := loadBatch(query.QueryRow(ctx, `SELECT batch_number,from_position,previous_hash,frames,hash,canonical_bytes FROM chat_turn_batches WHERE turn_id=$1 AND batch_number=$2`, turn.ID, after.Batch))
		if errors.Is(readErr, pgx.ErrNoRows) {
			return ReplayResult{}, ErrCorrupt
		}
		if readErr != nil {
			return ReplayResult{}, readErr
		}
		boundary, meta, verifyErr := verifyStoredBatch(turn, after.Batch, boundary, storedBytes)
		if verifyErr != nil || (meta.Type == "done" && boundary.Batch != head.Batch) || (boundary.Batch == head.Batch && (meta.Type == "done") != turn.Terminal) {
			return ReplayResult{}, ErrCorrupt
		}
		if !sameCursor(after, cursorAfter(boundary)) {
			return ReplayResult{}, ErrCursorConflict
		}
	}
	rows, err := query.Query(ctx, `SELECT batch_number,from_position,previous_hash,frames,hash,canonical_bytes FROM chat_turn_batches WHERE turn_id=$1 AND batch_number>$2 AND batch_number<=$3 ORDER BY batch_number LIMIT $4`, turn.ID, after.Batch, head.Batch, limit)
	if err != nil {
		return ReplayResult{}, err
	}
	defer rows.Close()
	batches := make([]Batch, 0, limit)
	next := after
	for rows.Next() {
		batch, storedBytes, scanErr := loadBatch(rows)
		if scanErr != nil {
			return ReplayResult{}, scanErr
		}
		batch, meta, verifyErr := verifyStoredBatch(turn, next.Batch+1, batch, storedBytes)
		if verifyErr != nil || batch.From != next.Position+1 || !equalSecret(batch.PreviousHash, next.Hash) {
			return ReplayResult{}, ErrCorrupt
		}
		if meta.Type == "done" && batch.Batch != head.Batch {
			return ReplayResult{}, ErrCorrupt
		}
		batches = append(batches, batch)
		next = cursorAfter(batch)
	}
	if err = rows.Err(); err != nil {
		return ReplayResult{}, err
	}
	// Batches and head commit in one transaction and Replay reads one
	// snapshot, so a short page means stored batches are missing. Returning
	// More without progress would spin the stream on the same empty range.
	if int64(len(batches)) != min(int64(limit), head.Batch-after.Batch) {
		return ReplayResult{}, ErrCorrupt
	}
	if next.Batch == head.Batch {
		if !sameCursor(next, head) {
			return ReplayResult{}, ErrCorrupt
		}
		if len(batches) > 0 {
			meta, frameErr := validateFrames(batches[len(batches)-1].Frames, turn.RunID)
			if frameErr != nil || (meta.Type == "done") != turn.Terminal {
				return ReplayResult{}, ErrCorrupt
			}
		}
	}
	return ReplayResult{Status: "ok", After: after, Next: next, Head: head, Terminal: turn.Terminal, More: next.Batch < head.Batch, Batches: batches}, nil
}

func (s *Store) Replay(ctx context.Context, input ReplayInput) (ReplayResult, error) {
	if !validIdentity(input.RunID) || !validJournal(input.Journal) || (input.After != nil && !validCursor(*input.After)) {
		return ReplayResult{}, ErrInvalidRequest
	}
	if input.Limit <= 0 {
		input.Limit = 8
	}
	if input.Limit > maxReplayBatches {
		return ReplayResult{}, ErrLimit
	}
	ownerHash, accessHash, err := authHashes(input.Scope, input.Journal.Token)
	if err != nil {
		return ReplayResult{}, err
	}
	return s.replay(ctx, input.Scope, input.RunID, input.Journal.LegID, input.After, input.Limit, ownerHash, &accessHash)
}

// Both account and device reads verify the same committed snapshot. Only
// authenticated account recovery omits the additional device capability.
func (s *Store) replay(ctx context.Context, scope Scope, runID, legID string, requested *Cursor, limit int, ownerHash string, accessHash *string) (ReplayResult, error) {
	// One read-only snapshot keeps the head and its batches consistent without
	// taking a row lock that would contend with the producer's commits.
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ReplayResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	turn, err := scanTurn(tx.QueryRow(ctx, `SELECT /* smithers-chat-replay-head */ `+turnColumns+` FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3`, scope.UserID, runID, legID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ReplayResult{}, ErrNotFound
	}
	if err != nil {
		return ReplayResult{}, err
	}
	if accessHash == nil {
		err = authorizeAccount(turn, ownerHash)
	} else {
		err = authorize(turn, ownerHash, *accessHash)
	}
	if err != nil {
		return ReplayResult{}, err
	}
	acceptance, _, err := checkHead(turn)
	if err != nil {
		return ReplayResult{}, err
	}
	after := initialCursor(acceptance)
	if requested != nil {
		after = *requested
	}
	if s.afterReplayHead != nil {
		s.afterReplayHead()
	}
	result, err := s.replayVerified(ctx, tx, turn, after, limit)
	if err != nil {
		return ReplayResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ReplayResult{}, err
	}
	return result, nil
}

func cancelledFrame(runID string) json.RawMessage {
	value, _ := json.Marshal(map[string]any{"runId": runID, "type": "done", "reason": "cancelled"})
	return value
}

func errorFrame(runID, message string) json.RawMessage {
	value, _ := json.Marshal(map[string]any{"runId": runID, "type": "done", "error": message})
	return value
}

func (s *Store) appendTerminalTx(ctx context.Context, tx pgx.Tx, turn *turnRecord, frame json.RawMessage, state State, now time.Time) error {
	acceptance, expected, err := checkHead(*turn)
	if err != nil {
		return err
	}
	if turn.Terminal {
		return nil
	}
	batch, bytes, err := makeBatch(expected, []json.RawMessage{frame})
	if err != nil || bytes > terminalReserveBytes || batch.Batch > maxBatches+1 {
		if err != nil {
			return err
		}
		return ErrLimit
	}
	frames, _ := json.Marshal(batch.Frames)
	if _, err = tx.Exec(ctx, `INSERT INTO chat_turn_batches(turn_id,batch_number,from_position,previous_hash,frames,hash,canonical_bytes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		turn.ID, batch.Batch, batch.From, batch.PreviousHash, frames, batch.Hash, bytes, now); err != nil {
		return err
	}
	next := cursorAfter(batch)
	nextBytes := turn.OutputBytes + int64(bytes)
	hash, err := headHash(acceptance, next, nextBytes, true)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE chat_turns SET head_batch=$2,head_position=$3,cursor_hash=$4,head_hash=$5,output_bytes=$6,terminal=true,state=$7,
		producer_lease_expires_at=NULL,updated_at=$8 WHERE id=$1`, turn.ID, next.Batch, next.Position, next.Hash, hash, nextBytes, state, now); err != nil {
		return err
	}
	turn.HeadBatch, turn.HeadPosition, turn.CursorHash, turn.HeadHash = next.Batch, next.Position, &next.Hash, &hash
	turn.OutputBytes, turn.Terminal, turn.State = nextBytes, true, state
	return notifyTx(ctx, tx, turn.ID)
}

func (s *Store) Cancel(ctx context.Context, scope Scope, runID string) (CancelResult, error) {
	if scope.UserID <= 0 || !validIdentity(runID) {
		return CancelResult{}, ErrInvalidRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return CancelResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	rows, err := tx.Query(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND state<>'retired' ORDER BY created_at FOR UPDATE`, scope.UserID, runID)
	if err != nil {
		return CancelResult{}, err
	}
	var turns []turnRecord
	for rows.Next() {
		turn, scanErr := scanTurn(rows)
		if scanErr != nil {
			rows.Close()
			return CancelResult{}, scanErr
		}
		turns = append(turns, turn)
	}
	rows.Close()
	if len(turns) == 0 {
		return CancelResult{}, ErrNotFound
	}
	now := s.now().UTC()
	result := CancelResult{}
	for index := range turns {
		turn := &turns[index]
		if turn.Terminal {
			continue
		}
		// cancel_requested_at is an audit timestamp. The same transaction seals
		// the turn, so no producer path ever sees it on a live turn.
		if _, err = tx.Exec(ctx, `UPDATE chat_turns SET cancel_requested_at=COALESCE(cancel_requested_at,$2),updated_at=$2 WHERE id=$1`, turn.ID, now); err != nil {
			return CancelResult{}, err
		}
		turn.CancelRequestedAt = &now
		if err = s.appendTerminalTx(ctx, tx, turn, cancelledFrame(turn.RunID), StateCancelled, now); err != nil {
			return CancelResult{}, err
		}
		result.TurnIDs = append(result.TurnIDs, turn.ID)
	}
	result.Count = len(result.TurnIDs)
	if err = tx.Commit(ctx); err != nil {
		return CancelResult{}, err
	}
	for _, turnID := range result.TurnIDs {
		s.signals.notify(turnID)
	}
	return result, nil
}

func (s *Store) Retire(ctx context.Context, input ReplayInput) error {
	if !validIdentity(input.RunID) || !validJournal(input.Journal) {
		return ErrInvalidRequest
	}
	ownerHash, accessHash, err := authHashes(input.Scope, input.Journal.Token)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	turn, err := scanTurn(tx.QueryRow(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE user_id=$1 AND run_id=$2 AND leg_id=$3 FOR UPDATE`, input.Scope.UserID, input.RunID, input.Journal.LegID))
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if turn.OwnerHash == nil || !equalSecret(*turn.OwnerHash, ownerHash) || !equalSecret(turn.AccessHash, accessHash) {
		return ErrForbidden
	}
	if turn.State == StateRetired {
		return tx.Commit(ctx)
	}
	if err = s.retireTurnTx(ctx, tx, turn); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Erase is authorized only by the hash of a replay token. The proof cannot be
// exchanged for a token or used by Replay, and no account context is needed.
func (s *Store) Erase(ctx context.Context, runID, legID, proof string) error {
	if !validIdentity(runID) || !validIdentity(legID) || !hexHashPattern.MatchString(proof) {
		return ErrInvalidRequest
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if err = lockTurnIdentity(ctx, tx, runID, legID); err != nil {
		return err
	}
	// Only the turns this proof admitted are erased. Another account's turn
	// under the same public identity neither blocks nor is touched.
	rows, err := tx.Query(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE run_id=$1 AND leg_id=$2 AND access_hash=$3 FOR UPDATE`, runID, legID, proof)
	if err != nil {
		return err
	}
	var turns []turnRecord
	for rows.Next() {
		turn, scanErr := scanTurn(rows)
		if scanErr != nil {
			rows.Close()
			return scanErr
		}
		turns = append(turns, turn)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, turn := range turns {
		if turn.State == StateRetired {
			continue
		}
		if err = s.retireTurnTx(ctx, tx, turn); err != nil {
			return err
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO chat_turn_erasures(run_id,leg_id,access_hash,retired_at) VALUES($1,$2,$3,$4)
		ON CONFLICT(run_id,leg_id,access_hash) DO NOTHING`, runID, legID, proof, s.now().UTC())
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) retireTurnTx(ctx context.Context, tx pgx.Tx, turn turnRecord) error {
	if turn.AcceptanceHash == nil {
		return ErrCorrupt
	}
	now := s.now().UTC()
	body := retirementUnsigned{Version: 1, Retired: true, RunID: turn.RunID, LegID: turn.LegID, OwnerHash: turn.OwnerHash, AccessHash: turn.AccessHash,
		AcceptanceHash: turn.AcceptanceHash, Batches: turn.HeadBatch, ErasedBatches: turn.HeadBatch + 1, RetiredAt: float64(now.UnixMilli())}
	hash, err := digest("retirement", body)
	if err != nil {
		return err
	}
	tombstone, err := json.Marshal(retirement{retirementUnsigned: body, Hash: hash})
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM chat_turn_batches WHERE turn_id=$1`, turn.ID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE chat_turns SET request_payload=NULL,writer_hash=NULL,acceptance=NULL,accepted_at_ms=NULL,cursor_hash=NULL,head_hash=NULL,
		producer_token_hash=NULL,producer_lease_expires_at=NULL,producer_started_at=NULL,terminal=true,state='retired',retirement=$2,updated_at=$3 WHERE id=$1`, turn.ID, tombstone, now)
	return err
}

func (s *Store) RecoveryCandidates(ctx context.Context, limit int) ([]Candidate, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	// A lease is a live producer, a retry backoff or a quarantine. Its expiry
	// uses the Go clock, as Claim does, so clock skew between a replica and
	// PostgreSQL cannot make recovery and Claim disagree.
	rows, err := s.pool.Query(ctx, `SELECT repository_id,user_id,id FROM chat_turns WHERE state IN ('accepted','running') AND (producer_lease_expires_at IS NULL OR producer_lease_expires_at<=$2) ORDER BY created_at LIMIT $1`, limit, s.now().UTC())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	values := make([]Candidate, 0)
	for rows.Next() {
		var candidate Candidate
		if err = rows.Scan(&candidate.Scope.RepositoryID, &candidate.Scope.UserID, &candidate.TurnID); err != nil {
			return nil, err
		}
		values = append(values, candidate)
	}
	return values, rows.Err()
}

// maxProducerAttempts bounds how many producer generations a turn gets while
// its provider has never started.
const maxProducerAttempts = 5

// FailProducer seals a turn whose producer stopped without a terminal batch.
func (s *Store) FailProducer(ctx context.Context, grant ProducerGrant, code string) error {
	_, err := s.stopProducer(ctx, grant, code, -1)
	return err
}

// RetryProducer hands a turn back for another attempt after delay when its
// host failed before any provider started, such as a model host that was
// restarting. Nothing reached a provider, so a rerun is safe. The old
// generation is fenced. A started provider, or a turn out of attempts, is
// sealed as FailProducer would. It reports whether the turn will rerun.
func (s *Store) RetryProducer(ctx context.Context, grant ProducerGrant, code string, delay time.Duration) (bool, error) {
	if delay < 0 {
		return false, ErrInvalidRequest
	}
	return s.stopProducer(ctx, grant, code, delay)
}

// stopProducer ends one producer generation. A negative delay never retries.
func (s *Store) stopProducer(ctx context.Context, grant ProducerGrant, code string, delay time.Duration) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	turn, err := scanTurn(tx.QueryRow(ctx, `SELECT `+turnColumns+` FROM chat_turns WHERE id=$1 FOR UPDATE`, grant.TurnID))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, ErrNotFound
	}
	if err != nil {
		return false, err
	}
	if turn.ProducerGeneration != grant.Generation || turn.ProducerTokenHash == nil || !equalSecret(*turn.ProducerTokenHash, hashToken(grant.Token)) {
		return false, ErrProducerFenced
	}
	if turn.Terminal {
		return false, tx.Commit(ctx)
	}
	now := s.now().UTC()
	if delay >= 0 && turn.ProducerStartedAt == nil && turn.ProducerGeneration < maxProducerAttempts {
		if _, err = tx.Exec(ctx, `UPDATE chat_turns SET producer_token_hash=NULL,producer_lease_expires_at=$2,updated_at=$3 WHERE id=$1`,
			turn.ID, now.Add(delay), now); err != nil {
			return false, err
		}
		return true, tx.Commit(ctx)
	}
	state := StateFailed
	frame := errorFrame(turn.RunID, "The model host stopped before completing the turn.")
	if code == "credential_missing" {
		frame, _ = json.Marshal(map[string]any{"runId": turn.RunID, "type": "done", "code": "credential_missing", "error": "Model credential missing."})
	}
	if turn.ProducerStartedAt != nil {
		state = StateUncertain
	}
	if err = s.appendTerminalTx(ctx, tx, &turn, frame, state, now); err != nil {
		return false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	s.signals.notify(turn.ID)
	return false, nil
}

// Quarantine keeps a turn Claim cannot take, such as one whose journal no
// longer verifies, out of recovery for delay, so it cannot crowd live turns
// out of the oldest-first recovery scan.
func (s *Store) Quarantine(ctx context.Context, candidate Candidate, delay time.Duration) error {
	now := s.now().UTC()
	_, err := s.pool.Exec(ctx, `UPDATE chat_turns SET producer_lease_expires_at=$3,updated_at=$4
		WHERE id=$1 AND user_id=$2 AND NOT terminal AND state IN ('accepted','running')
		AND (producer_lease_expires_at IS NULL OR producer_lease_expires_at<=$4)`,
		candidate.TurnID, candidate.Scope.UserID, now.Add(delay), now)
	return err
}

// EndedAmong returns the turns among ids that are terminal, so a dispatcher
// can stop a host whose turn another replica cancelled or retired.
func (s *Store) EndedAmong(ctx context.Context, ids []string) ([]string, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id FROM chat_turns WHERE id = ANY($1) AND terminal`, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

func (s *Store) GetState(ctx context.Context, scope Scope, turnID string) (State, bool, error) {
	var state State
	var terminal bool
	err := s.pool.QueryRow(ctx, `SELECT state,terminal FROM chat_turns WHERE id=$1 AND user_id=$2`, turnID, scope.UserID).Scan(&state, &terminal)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, ErrNotFound
	}
	return state, terminal, err
}

func (s *Store) String() string { return fmt.Sprintf("chat.Store(%p)", s.pool) }
