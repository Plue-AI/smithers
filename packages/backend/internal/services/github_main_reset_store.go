package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// GitHubMainStackContracts is supplied by the stack lanes. Its transaction
// methods never commit independently. Ready refuses absent rebase and isolated
// main-moved consumers. ValidateReset rereads stored attention and merge fences;
// SettleReset writes all stack projections and keyed consumer intents atomically.
type GitHubMainStackContracts interface {
	Ready(context.Context) error
	OpenForcePush(context.Context, pgx.Tx, int64, GitHubMainForcePush) error
	ValidateReset(context.Context, pgx.Tx, int64, string, string, string) (string, error)
	VerifyPull(context.Context, pgx.Tx, int64, string, string) error
	SettleReset(context.Context, pgx.Tx, GitHubMainResetIntent) error
	LeaveOpen(context.Context, pgx.Tx, GitHubMainResetIntent) error
}

// GitHubMainResetJournal owns persistence, while the stack supplies its fold.
// No production substitute for missing stack contracts is provided.
type GitHubMainResetJournal struct {
	Pool  *pgxpool.Pool
	Stack GitHubMainStackContracts
}

var errMainResetIntentMissing = errors.New("reset intent already retired")

type githubMainJournalFence struct {
	journal    *GitHubMainResetJournal
	conn       *pgxpool.Conn
	repository int64
}

func (j *GitHubMainResetJournal) ready(ctx context.Context) error {
	if j == nil || j.Pool == nil || j.Stack == nil {
		return githubSyncUnavailable()
	}
	return j.Stack.Ready(ctx)
}

func (j *GitHubMainResetJournal) WithRepository(ctx context.Context, repository int64, run func(GitHubMainFence) error) error {
	if err := j.ready(ctx); err != nil {
		return err
	}
	conn, err := j.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// Session lock survives the intent transaction's commit and the ref transfer.
	// Namespacing avoids the stack worker's nested placement/factory locks.
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended('github_main_operation:' || $1::text,0))`, fmt.Sprint(repository)); err != nil {
		// A cancelled lock acquisition can have acquired just before cancellation.
		// Never return a possibly locked connection to the pool.
		_ = conn.Hijack().Close(context.Background())
		return err
	}
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := conn.QueryRow(release, `SELECT pg_advisory_unlock(hashtextextended('github_main_operation:' || $1::text,0))`, fmt.Sprint(repository)).Scan(&unlocked); err != nil || !unlocked {
			_ = conn.Hijack().Close(release)
		} else {
			conn.Release()
		}
	}()
	return run(&githubMainJournalFence{j, conn, repository})
}

func (j *GitHubMainResetJournal) Pending(ctx context.Context) ([]GitHubMainResetIntent, error) {
	if err := j.ready(ctx); err != nil {
		return nil, err
	}
	rows, err := j.Pool.Query(ctx, `SELECT reset_intent FROM github_main_pulls WHERE reset_intent IS NOT NULL AND reset_intent->>'settled' IS DISTINCT FROM 'true' ORDER BY repository_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var intents []GitHubMainResetIntent
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var intent GitHubMainResetIntent
		if err := json.Unmarshal(raw, &intent); err != nil {
			return nil, err
		}
		intents = append(intents, intent)
	}
	return intents, rows.Err()
}

func (f *githubMainJournalFence) transaction(ctx context.Context, body func(pgx.Tx) error) error {
	if err := f.journal.ready(ctx); err != nil {
		return err
	}
	return pgx.BeginFunc(ctx, f.conn, func(tx pgx.Tx) error {
		var id int64
		if err := tx.QueryRow(ctx, `SELECT repository_id FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, f.repository).Scan(&id); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return githubSyncUnavailable()
			}
			return err
		}
		return body(tx)
	})
}

func (f *githubMainJournalFence) OpenForcePush(ctx context.Context, push GitHubMainForcePush) error {
	return f.transaction(ctx, func(tx pgx.Tx) error { return f.journal.Stack.OpenForcePush(ctx, tx, f.repository, push) })
}

func (f *githubMainJournalFence) Prepare(ctx context.Context, id, old, new string) (GitHubMainResetIntent, error) {
	var intent GitHubMainResetIntent
	err := f.transaction(ctx, func(tx pgx.Tx) error {
		var saved []byte
		if err := tx.QueryRow(ctx, `SELECT reset_intent FROM github_main_pulls WHERE repository_id=$1 FOR UPDATE`, f.repository).Scan(&saved); err != nil {
			return err
		}
		if saved != nil {
			var prior GitHubMainResetIntent
			if err := json.Unmarshal(saved, &prior); err != nil {
				return err
			}
			if prior.Settled && (id == "" || id == prior.ID) && old == prior.Old && new == prior.New {
				intent = prior
				return nil
			}
		}
		attention, err := f.journal.Stack.ValidateReset(ctx, tx, f.repository, id, old, new)
		if err != nil {
			return err
		}
		intent = GitHubMainResetIntent{RepositoryID: f.repository, ID: attention, Old: old, New: new}
		if auth := middleware.AuthInfoFromContext(ctx); auth != nil && auth.User != nil {
			intent.ActorID = auth.User.ID
		}
		if attention == "" || (id != "" && id != attention) || old == new || !repositorySourceSHA.MatchString(old) || !repositorySourceSHA.MatchString(new) {
			return staleMainReset()
		}
		raw, err := json.Marshal(intent)
		if err != nil {
			return err
		}
		result, err := tx.Exec(ctx, `UPDATE github_main_pulls SET reset_intent=$2,updated_at=now() WHERE repository_id=$1 AND (reset_intent IS NULL OR reset_intent=$2::jsonb OR reset_intent->>'settled'='true')`, f.repository, raw)
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return staleMainReset()
		}
		return nil
	})
	return intent, err
}

func (f *githubMainJournalFence) verifyIntent(ctx context.Context, tx pgx.Tx, intent GitHubMainResetIntent) error {
	if intent.RepositoryID != f.repository {
		return staleMainReset()
	}
	raw, err := json.Marshal(intent)
	if err != nil {
		return err
	}
	var matches bool
	err = tx.QueryRow(ctx, `SELECT reset_intent=$2::jsonb FROM github_main_pulls WHERE repository_id=$1 AND reset_intent IS NOT NULL AND reset_intent->>'settled' IS DISTINCT FROM 'true' FOR UPDATE`, f.repository, raw).Scan(&matches)
	if errors.Is(err, pgx.ErrNoRows) {
		return errMainResetIntentMissing
	}
	if err == nil && !matches {
		return staleMainReset()
	}
	return err
}

func (f *githubMainJournalFence) VerifyLocked(ctx context.Context, intent GitHubMainResetIntent) error {
	return f.transaction(ctx, func(tx pgx.Tx) error {
		if err := f.verifyIntent(ctx, tx, intent); err != nil {
			if errors.Is(err, errMainResetIntentMissing) {
				return staleMainReset()
			}
			return err
		}
		id, err := f.journal.Stack.ValidateReset(ctx, tx, f.repository, intent.ID, intent.Old, intent.New)
		if err != nil {
			return err
		}
		if id != intent.ID {
			return staleMainReset()
		}
		return nil
	})
}
func (f *githubMainJournalFence) VerifyPull(ctx context.Context, old, new string) error {
	return f.transaction(ctx, func(tx pgx.Tx) error {
		var pending bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM github_main_pulls WHERE repository_id=$1 AND reset_intent IS NOT NULL AND reset_intent->>'settled' IS DISTINCT FROM 'true')`, f.repository).Scan(&pending); err != nil {
			return err
		}
		if pending {
			return staleMainReset()
		}
		return f.journal.Stack.VerifyPull(ctx, tx, f.repository, old, new)
	})
}

func (f *githubMainJournalFence) finish(ctx context.Context, intent GitHubMainResetIntent, settle bool) error {
	return f.transaction(ctx, func(tx pgx.Tx) error {
		if err := f.verifyIntent(ctx, tx, intent); err != nil {
			if errors.Is(err, errMainResetIntentMissing) {
				return nil
			}
			return err
		}
		var err error
		if settle {
			err = f.journal.Stack.SettleReset(ctx, tx, intent)
		} else {
			err = f.journal.Stack.LeaveOpen(ctx, tx, intent)
		}
		if err != nil {
			return err
		}
		var result pgconn.CommandTag
		if settle {
			result, err = tx.Exec(ctx, `UPDATE github_main_pulls SET reset_intent=reset_intent || '{"settled":true}'::jsonb,updated_at=now(),last_synced_at=now(),last_checked_at=now(),github_head=$2,smithers_head=$2,state='synced',last_error='',health_cause='',retry_at=NULL,next_attempt_at=now() WHERE repository_id=$1`, f.repository, intent.New)
		} else {
			result, err = tx.Exec(ctx, `UPDATE github_main_pulls SET reset_intent=NULL,updated_at=now() WHERE repository_id=$1`, f.repository)
		}
		if err != nil {
			return err
		}
		if result.RowsAffected() != 1 {
			return fmt.Errorf("reset receipt disappeared")
		}
		return nil
	})
}
func (f *githubMainJournalFence) Settle(ctx context.Context, intent GitHubMainResetIntent) error {
	return f.finish(ctx, intent, true)
}
func (f *githubMainJournalFence) LeaveOpen(ctx context.Context, intent GitHubMainResetIntent) error {
	return f.finish(ctx, intent, false)
}

// Merge dispatch records its persistent fence before releasing this same
// operation lock. Reset cannot overtake either the claim or its sent request.
func lockMainOperationTx(ctx context.Context, tx pgx.Tx, repository int64) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('github_main_operation:' || $1::text,0))`, fmt.Sprint(repository))
	return err
}
