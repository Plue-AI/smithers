package services

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// Projection retention (spec §3.3): a topic keeps its rows of the last 24
// hours or its newest 10,000, whichever is larger. A subscriber whose cursor
// is older than the oldest kept row gets a fresh snapshot (T-COL-02).
const (
	ProjectionRetentionAge  = 24 * time.Hour
	ProjectionRetentionRows = 10_000
)

// Projection is one card change for one live topic (spec §7.2): todo:<n>,
// home, branch:<id>:activity and the rest.
type Projection struct {
	RepositoryID int64 // 0 for an install topic, otherwise its repository.
	Topic        string
	Payload      any
}

// ProjectionTopicTodo names a TODO's topic.
func ProjectionTopicTodo(number int64) string { return fmt.Sprintf("todo:%d", number) }

// ProjectionTopicHome is the stack's Home card topic.
const ProjectionTopicHome = "home"

// ProjectionTopicBranchActivity names a branch's activity topic.
func ProjectionTopicBranchActivity(branchID string) string { return "branch:" + branchID + ":activity" }

// Publish appends one projection_events row per projection in tx and queues
// NOTIFY live, '<topic>' for each, which PostgreSQL delivers only when tx
// commits (spec §3.1). It answers the seq each topic got, in order. Each
// topic's seq is gap-free and in commit order: the topic's row stays locked
// until tx ends. Topics are locked in name order, so two writers never wait
// on each other's topics; call Publish last in the transaction, after every
// row change it reports.
func Publish(ctx context.Context, tx pgx.Tx, projections ...Projection) ([]int64, error) {
	ordered := make([]int, len(projections))
	for i := range ordered {
		ordered[i] = i
	}
	sort.SliceStable(ordered, func(a, b int) bool {
		left, right := projections[ordered[a]], projections[ordered[b]]
		if left.RepositoryID != right.RepositoryID {
			return left.RepositoryID < right.RepositoryID
		}
		return left.Topic < right.Topic
	})
	q := db.New(tx)
	seqs := make([]int64, len(projections))
	for _, index := range ordered {
		projection := projections[index]
		if projection.Topic == "" || projection.RepositoryID < 0 {
			return nil, fmt.Errorf("publish: empty topic")
		}
		payload, err := json.Marshal(projection.Payload)
		if err != nil {
			return nil, fmt.Errorf("publish %s: %w", projection.Topic, err)
		}
		seq, err := q.NextProjectionSeq(ctx, db.NextProjectionSeqParams{RepositoryID: projection.RepositoryID, Topic: projection.Topic})
		if err != nil {
			return nil, fmt.Errorf("publish %s: %w", projection.Topic, err)
		}
		if _, err := q.InsertProjectionEvent(ctx, db.InsertProjectionEventParams{RepositoryID: projection.RepositoryID, Topic: projection.Topic, Seq: seq, Payload: payload}); err != nil {
			return nil, fmt.Errorf("publish %s: %w", projection.Topic, err)
		}
		notification, _ := json.Marshal(struct {
			RepositoryID int64  `json:"repository_id"`
			Topic        string `json:"topic"`
		}{projection.RepositoryID, projection.Topic})
		if err := q.NotifyLive(ctx, string(notification)); err != nil {
			return nil, fmt.Errorf("publish %s: %w", projection.Topic, err)
		}
		seqs[index] = seq
	}
	return seqs, nil
}

// ProjectionRetention prunes projection_events past §3.3's retention.
type ProjectionRetention struct{ queries *db.Queries }

// NewProjectionRetention prunes through conn.
func NewProjectionRetention(conn db.DBTX) *ProjectionRetention {
	return &ProjectionRetention{queries: db.New(conn)}
}

// Prune deletes, per topic, the rows older than ProjectionRetentionAge at now
// that are also outside the topic's newest ProjectionRetentionRows, and
// answers how many it deleted.
func (r *ProjectionRetention) Prune(ctx context.Context, now time.Time) (int64, error) {
	return r.queries.PruneProjectionEvents(ctx, db.PruneProjectionEventsParams{
		Cutoff: now.Add(-ProjectionRetentionAge), Keep: ProjectionRetentionRows,
	})
}
