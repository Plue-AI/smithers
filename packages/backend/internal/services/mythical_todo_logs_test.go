package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/blob"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestTodoReceiptLogRetention(t *testing.T) {
	ctx := context.Background()
	store := blob.NewMemoryStore()
	service := &MythicalService{todoLogs: store}
	text := "check stdout\ncheck stderr\n"
	output, _ := json.Marshal(map[string]any{"receipts": []any{map[string]any{"checkId": "build", "tier": "fast", "status": "passed", "commitId": "head", "evidence": text}}})
	measured := mythicalRunReceipts("verify", "run", receiptUpdate(string(output)), true)
	require.Equal(t, text, measured.Checks[0].Evidence)
	item := db.MythicalItem{Source: "todo", RepositoryID: 42, Attempt: 1, CandidateHead: "head", Checks: mythicalChecks{Receipts: measured}.encode()}
	require.NoError(t, service.persistTodoLogs(ctx, &item))
	hash := sha256.Sum256([]byte(text))
	digest := hex.EncodeToString(hash[:])
	receipt := mythicalChecksOf(item).Receipts.Checks[0]
	require.Equal(t, digest, receipt.LogDigest)
	require.Empty(t, receipt.Evidence)
	reader, err := store.NewReader(ctx, todoLogKey(42, digest))
	require.NoError(t, err)
	payload, err := io.ReadAll(reader)
	reader.Close()
	require.NoError(t, err)
	require.Equal(t, text, string(payload))
	item = retainTodoAttemptEvidence(item)
	require.Equal(t, digest, todoEvidence(item)[0].Items[0]["log_digest"])
	old := mythicalChecksOf(item).Attempts[0]
	item.Attempt = 2
	item.CandidateHead = "new"
	checks := mythicalChecksOf(item)
	checks.Receipts = nil
	item.Checks = checks.encode()
	item = retainTodoAttemptEvidence(item)
	require.Equal(t, old, todoEvidence(item)[0])
	require.NoError(t, service.persistTodoLogs(ctx, &item))
}

func TestTodoLogWriteRefusesUnavailableOrOversized(t *testing.T) {
	for _, text := range []string{"bytes", strings.Repeat("x", todoLogLimit+1)} {
		item := db.MythicalItem{Source: "todo", Checks: mythicalChecks{Receipts: &mythicalReceipts{Checks: []mythicalReceipt{{Evidence: text}}}}.encode()}
		original := append([]byte(nil), item.Checks...)
		require.Error(t, (&MythicalService{}).persistTodoLogs(context.Background(), &item))
		require.Equal(t, original, []byte(item.Checks))
	}
}

func TestTodoMergeSettlesIndependentWaitsAndPause(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	for _, state := range []string{"queued", "running", "proposed", "blocked"} {
		item := db.MythicalItem{Source: "todo", State: state, PausedAt: pgtype.Timestamptz{Time: now, Valid: true}, Checks: mythicalChecks{Waits: []TodoWait{{ID: "question", Kind: "question"}, {ID: "branch", Kind: "foreign_push"}}}.encode()}
		landed := mythicalLanded(item, "merge", now)
		require.Equal(t, "merged", todoState(landed))
		require.False(t, landed.PausedAt.Valid)
		for _, wait := range mythicalChecksOf(landed).Waits {
			require.Equal(t, &now, wait.SettledAt)
		}
	}
}

func TestTodoTerminalRuntimeCallbacksChangeNothing(t *testing.T) {
	o, _, _, item, launch := newAskingTodo(t)
	ctx := context.Background()
	for _, state := range []string{"landed", "cancelled", "rejected", "declined"} {
		_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET state=$2 WHERE id=$1`, item.ID, state)
		require.NoError(t, err)
		before := o.byID(uuidString(item.ID))
		var events int
		require.NoError(t, o.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&events))
		o.projectAsking(launch, jobs.StateWaiting, "todo-run-1", humanAsk("late-token", "clarify", "Too late?"))
		require.Equal(t, before, o.byID(uuidString(item.ID)))
		var after int
		require.NoError(t, o.pool.QueryRow(ctx, `SELECT count(*) FROM product_job_events`).Scan(&after))
		require.Equal(t, events, after)
	}
	// A final receipt from that same bound run remains evidence after merge.
	_, err := o.pool.Exec(ctx, `UPDATE mythical_items SET state='landed' WHERE id=$1`, item.ID)
	require.NoError(t, err)
	o.projectTodo(launch, jobs.StateCompleted, "todo-run-1", todoPinOne, `{}`)
	settled := o.byID(uuidString(item.ID))
	require.Equal(t, "completed", settled.RequestOutcome)
	require.Equal(t, "merged", todoState(settled))
	require.Empty(t, todoOpenWaits(settled))
}
