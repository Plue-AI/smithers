package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/flowdispatch"
	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/live"
)

// Runs reuse the dispatch checkpoint's host binding and the host's journal.
// Reading a topic never resolves a new host, launches a run, or copies its
// events into a product table. Branch authorization precedes every read.
func (t *liveTopics) runSource(ctx context.Context, run string, repository, member int64) (live.Source, string) {
	if t.changePool == nil || t.presence == nil || t.presence.branches == nil || t.presence.dispatcher == nil {
		return live.Source{}, live.Unsupported
	}
	if run == "" || repository <= 0 || member <= 0 {
		return live.Source{}, live.UnknownTopic
	}
	var raw []byte
	err := t.changePool.QueryRow(ctx, `SELECT d.external_receipt FROM product_job_dispatches d
		JOIN product_job_requests r ON r.id=d.operation_id
		WHERE r.operation=$1 AND d.external_receipt->>'runId'=$2
		AND d.external_receipt->'target'->>'TenantID'=$3
		ORDER BY r.created_at DESC LIMIT 1`, flowdispatch.OperationLaunch, run, "repository:"+strconv.FormatInt(repository, 10)).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return live.Source{}, live.UnknownTopic
	}
	var checkpoint flowdispatch.RuntimeCheckpoint
	if err != nil || json.Unmarshal(raw, &checkpoint) != nil || checkpoint.RunID != run || checkpoint.Target.WorkspaceID == "" {
		return live.Source{}, live.Unsupported
	}
	authorize := func(ctx context.Context) error {
		_, err := t.presence.branches.PresenceBranch(ctx, checkpoint.Target.WorkspaceID, repository, member)
		return err
	}
	if err := authorize(ctx); err != nil {
		return live.Source{}, live.Forbidden
	}
	reader := runProjectionReader{call: t.presence.dispatcher.CallRPC, target: checkpoint.Target, run: run}
	return live.Source{Key: "run:" + run, Every: 250 * time.Millisecond, Log: &live.LogSource{Page: func(ctx context.Context, after *int64) (live.LogPage, error) {
		if err := authorize(ctx); err != nil {
			return live.LogPage{}, err
		}
		return reader.page(ctx, after)
	}}}, ""
}

type runProjectionCursor struct {
	Selector   map[string]string `json:"selector"`
	Projection string            `json:"projection"`
	RunID      string            `json:"runId"`
	Value      int64             `json:"value"`
	Offset     int64             `json:"offset"`
}

type runProjectionSnapshot struct {
	Cursor runProjectionCursor `json:"cursor"`
	Rows   []json.RawMessage   `json:"rows"`
}

type runProjectionReader struct {
	call   func(context.Context, flowruntime.Target, string, json.RawMessage) (json.RawMessage, error)
	target flowruntime.Target
	run    string
}

func (r runProjectionReader) snapshot(ctx context.Context, kind string, after *runProjectionCursor) (runProjectionSnapshot, error) {
	request := map[string]any{"selector": map[string]string{"_tag": kind, "runId": r.run}}
	if after != nil {
		request["after"] = after
	}
	body, err := json.Marshal(request)
	if err != nil {
		return runProjectionSnapshot{}, err
	}
	raw, err := r.call(ctx, r.target, "Projection.Snapshot", body)
	if err != nil {
		return runProjectionSnapshot{}, err
	}
	var answer struct {
		OK      bool                  `json:"ok"`
		Payload runProjectionSnapshot `json:"payload"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return runProjectionSnapshot{}, err
	}
	snapshot := answer.Payload
	if !answer.OK || snapshot.Rows == nil || snapshot.Cursor.RunID != r.run || snapshot.Cursor.Projection != kind || snapshot.Cursor.Value < 0 || snapshot.Cursor.Value > 9007199254740991 || snapshot.Cursor.Offset < 0 {
		return runProjectionSnapshot{}, fmt.Errorf("run projection unavailable")
	}
	return snapshot, nil
}

// A numeric Live cursor is the underlying journal entry, not an adapter
// counter. Entries can expand to several gateway events: only advance Live
// after the entire entry has been read, preserving their ordered offsets.
func (r runProjectionReader) page(ctx context.Context, after *int64) (live.LogPage, error) {
	for attempt := 0; attempt < 5; attempt++ {
		summary, err := r.snapshot(ctx, "run-summary", nil)
		if err != nil {
			return live.LogPage{}, err
		}
		if len(summary.Rows) != 1 {
			return live.LogPage{}, fmt.Errorf("run summary missing")
		}
		steps, err := r.snapshot(ctx, "run-tree", nil)
		if err != nil {
			return live.LogPage{}, err
		}
		if summary.Cursor.Value != steps.Cursor.Value || summary.Cursor.Offset != steps.Cursor.Offset {
			continue
		}
		head := summary.Cursor.Value
		if after != nil && *after > head {
			return live.LogPage{Gap: true}, nil
		}
		events := []json.RawMessage{}
		if after != nil && *after < head {
			cursor := runProjectionCursor{Selector: map[string]string{"_tag": "run-events", "runId": r.run}, Projection: "run-events", RunID: r.run, Value: *after, Offset: 9007199254740991}
			if *after > 0 {
				cursor.Value--
			}
			foundCursor := *after == 0
			lastSequence := cursor.Value
			bytes := 0
			for pages := 0; ; pages++ {
				if pages == 128 {
					return live.LogPage{Gap: true}, nil
				}
				page, err := r.snapshot(ctx, "run-events", &cursor)
				if err != nil {
					return live.LogPage{}, err
				}
				for _, raw := range page.Rows {
					var event flowruntime.Event
					if json.Unmarshal(raw, &event) != nil || event.RunID != "" && event.RunID != r.run {
						return live.LogPage{}, fmt.Errorf("invalid run event")
					}
					sequence := event.Sequence
					if event.Cursor != nil {
						sequence = event.Cursor.Sequence
					}
					if sequence < lastSequence {
						return live.LogPage{}, fmt.Errorf("run events out of order")
					}
					lastSequence = sequence
					if sequence == *after {
						foundCursor = true
					}
					if sequence > *after && sequence <= head {
						bytes += len(raw)
						if bytes > 2<<20 {
							return live.LogPage{Gap: true}, nil
						}
						events = append(events, raw)
					}
				}
				if page.Cursor.Value > head || page.Cursor.Value == head && page.Cursor.Offset >= summary.Cursor.Offset {
					break
				}
				if page.Cursor.Value < cursor.Value || page.Cursor.Value == cursor.Value && page.Cursor.Offset <= cursor.Offset {
					return live.LogPage{Gap: true}, nil
				}
				cursor = page.Cursor
			}
			if !foundCursor {
				return live.LogPage{Gap: true}, nil
			}
		}
		data, err := json.Marshal(map[string]any{"summary": summary.Rows[0], "steps": steps.Rows, "events": events})
		return live.LogPage{Cursor: head, Data: data}, err
	}
	return live.LogPage{}, fmt.Errorf("run changed throughout snapshot read")
}
