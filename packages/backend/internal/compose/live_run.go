package compose

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
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
	workspace := ""
	if prefix, id, qualified := strings.Cut(run, ":"); qualified {
		if prefix == "" || id == "" {
			return live.Source{}, live.UnknownTopic
		}
		workspace, run = prefix, id
	}
	var raw, admission []byte
	var matches int64
	err := t.changePool.QueryRow(ctx, `WITH matches AS (
        SELECT DISTINCT ON (d.external_receipt->'target'->>'WorkspaceID') d.external_receipt, r.payload
        FROM product_job_dispatches d JOIN product_job_requests r ON r.id=d.operation_id
        WHERE r.operation=$1 AND d.external_receipt->>'runId'=$2
        AND d.external_receipt->'target'->>'TenantID'=$3
        AND ($4='' OR d.external_receipt->'target'->>'WorkspaceID'=$4)
        ORDER BY d.external_receipt->'target'->>'WorkspaceID', r.created_at DESC
    ) SELECT external_receipt, payload, count(*) OVER () FROM matches LIMIT 1`,
		flowdispatch.OperationLaunch, run, "repository:"+strconv.FormatInt(repository, 10), workspace).Scan(&raw, &admission, &matches)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && matches != 1 {
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
	var launch struct {
		Target flowruntime.Target `json:"target"`
		FlowID string             `json:"flowId"`
		Pin    *flowruntime.Pin   `json:"pin"`
	}
	if json.Unmarshal(admission, &launch) != nil {
		return live.Source{}, live.Unsupported
	}
	draft := checkpoint.Target.BindingKind == flowdispatch.DraftBindingKind
	if launch.Pin != nil {
		if draft || !launch.Pin.Valid() || launch.Target != checkpoint.Target || launch.FlowID != checkpoint.FlowID || launch.Pin.Flow != checkpoint.FlowID || launch.Pin.ExecutionDigest != checkpoint.ExecutionDigest {
			return live.Source{}, live.Unsupported
		}
	}
	// Legacy receipts without a pin retain their journal read. Only admitted
	// metadata can name a version; reading never admits another TODO run.
	reader := runProjectionReader{call: t.presence.dispatcher.CallRPC, target: checkpoint.Target, run: run, pin: launch.Pin, draft: draft}
	return live.Source{Key: fmt.Sprintf("run:%d:%q:%q", repository, checkpoint.Target.WorkspaceID, run), Every: 250 * time.Millisecond, Log: &live.LogSource{Page: func(ctx context.Context, after *int64) (live.LogPage, error) {
		if err := authorize(ctx); err != nil {
			return live.LogPage{}, err
		}
		page, err := reader.page(ctx, after)
		if err == nil {
			return page, nil
		}
		// A read never wakes a sleeping branch: the run is served from its
		// host's own answers retained while the host was live (runArchive).
		archived, archiveErr := readRunArchive(ctx, t.changePool, repository, checkpoint.Target.WorkspaceID, run)
		if archiveErr != nil {
			return live.LogPage{}, err
		}
		page, projection, archiveErr := archived.livePage(ctx, after)
		if archiveErr != nil || page.Gap {
			return page, archiveErr
		}
		if launch.Pin != nil {
			projection["flow_version"] = map[string]string{"flow_name": launch.Pin.Flow, "source_commit": launch.Pin.SourceCommit, "digest": launch.Pin.ExecutionDigest}
		}
		if draft {
			projection["version"] = "draft version"
		}
		page.Data, archiveErr = json.Marshal(projection)
		return page, archiveErr
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
	pin    *flowruntime.Pin
	draft  bool
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
	if !answer.OK || snapshot.Rows == nil || snapshot.Cursor.RunID != r.run || snapshot.Cursor.Projection != kind || snapshot.Cursor.Selector["_tag"] != kind || snapshot.Cursor.Selector["runId"] != r.run || snapshot.Cursor.Value < 0 || snapshot.Cursor.Value > 9007199254740991 || snapshot.Cursor.Offset < 0 || snapshot.Cursor.Offset > 9007199254740991 {
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
		var identity struct {
			RunID  string `json:"runId"`
			FlowID string `json:"flowId"`
		}
		if json.Unmarshal(summary.Rows[0], &identity) != nil || identity.RunID != r.run || identity.FlowID == "" {
			return live.LogPage{}, fmt.Errorf("invalid run summary")
		}
		// Gateway health includes wall-clock freshness, which can differ for
		// two readers at one journal cursor. The shared base topic carries
		// committed run facts; the monitor owns the time-sensitive rollup.
		var committedSummary map[string]json.RawMessage
		if err := json.Unmarshal(summary.Rows[0], &committedSummary); err != nil {
			return live.LogPage{}, err
		}
		delete(committedSummary, "statusRollup")
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
		projection := map[string]any{"summary": committedSummary, "steps": steps.Rows, "events": events}
		if r.pin != nil {
			if identity.FlowID != r.pin.Flow {
				return live.LogPage{}, fmt.Errorf("run summary conflicts with admitted pin")
			}
			projection["flow_version"] = map[string]string{"flow_name": r.pin.Flow, "source_commit": r.pin.SourceCommit, "digest": r.pin.ExecutionDigest}
		}
		if r.draft {
			projection["version"] = "draft version"
		}
		data, err := json.Marshal(projection)
		return live.LogPage{Cursor: head, Data: data}, err
	}
	return live.LogPage{}, fmt.Errorf("run changed throughout snapshot read")
}
