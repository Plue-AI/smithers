package services

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The first Begin belongs to the writer. Hold it after its initial resolve,
// then let the owner change membership before the writer takes the lock.
type gatedTimelineBeginner struct {
	locks   advisoryLocks
	entered chan struct{}
	release chan struct{}
	first   bool
}

func (g *gatedTimelineBeginner) Begin(ctx context.Context) (pgx.Tx, error) {
	if !g.first {
		g.first = true
		close(g.entered)
		select {
		case <-g.release:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return g.locks.Begin(ctx)
}

func TestAppTimeline_QueuedWriteRejectsChangedMembership(t *testing.T) {
	for _, membership := range []string{"remove", "demote"} {
		for _, write := range []string{"append", "rewrite", "snapshot"} {
			t.Run(membership+"/"+write, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				f := seededTimelineStore(1)
				f.events[[2]any{testTimelineID, int64(0)}] = db.AppTimelineEvent{TimelineID: testTimelineID, Seq: 0, Payload: json.RawMessage(`{"original":true}`)}
				f.branches[[2]any{testTimelineID, int32(0)}] = db.AppTimelineBranch{TimelineID: testTimelineID, Ordinal: 0, FromSeq: 0, Events: json.RawMessage(`[{"branch":true}]`)}
				f.snapshots[[2]any{testTimelineID, int64(1)}] = db.AppTimelineSnapshot{TimelineID: testTimelineID, Seq: 1, State: json.RawMessage(`{"original":true}`)}
				f.users["editor"] = db.User{ID: 2, Username: "editor", LowerUsername: "editor"}
				beforeTimeline := f.timelines[testTimelineID]
				beforeEvents := make(map[[2]any]db.AppTimelineEvent, len(f.events))
				for k, v := range f.events {
					beforeEvents[k] = v
				}
				beforeBranches := make(map[[2]any]db.AppTimelineBranch, len(f.branches))
				for k, v := range f.branches {
					beforeBranches[k] = v
				}
				beforeSnapshots := make(map[[2]any]db.AppTimelineSnapshot, len(f.snapshots))
				for k, v := range f.snapshots {
					beforeSnapshots[k] = v
				}

				gate := &gatedTimelineBeginner{entered: make(chan struct{}), release: make(chan struct{})}
				s := NewAppTimelineService(f, WithAppTimelineTxBeginner(gate))
				result := make(chan error, 1)
				go func() {
					switch write {
					case "append":
						result <- s.AppendEvents(ctx, 2, testTimelineID, []AppTimelineEventWrite{{Seq: 0, Payload: json.RawMessage(`{"new":true}`)}})
					case "rewrite":
						result <- s.Rewrite(ctx, 2, testTimelineID, AppTimelineDump{Version: 1, Events: []json.RawMessage{json.RawMessage(`{"new":true}`)}})
					case "snapshot":
						result <- s.PutSnapshot(ctx, 2, testTimelineID, 1, json.RawMessage(`{"new":true}`))
					}
				}()
				select {
				case <-gate.entered:
				case <-ctx.Done():
					t.Fatal("writer did not reach lock")
				}
				if membership == "remove" {
					if err := s.RemoveMember(ctx, 1, testTimelineID, 2); err != nil {
						t.Fatal(err)
					}
				} else {
					if _, err := s.AddMember(ctx, 1, testTimelineID, "editor", AppTimelineRoleViewer); err != nil {
						t.Fatal(err)
					}
				}
				close(gate.release)
				select {
				case err := <-result:
					if membership == "remove" {
						wantStatus(t, err, http.StatusNotFound)
					} else {
						wantStatus(t, err, http.StatusForbidden)
					}
				case <-ctx.Done():
					t.Fatal("writer did not finish")
				}
				if got := f.timelines[testTimelineID]; !reflect.DeepEqual(got, beforeTimeline) {
					t.Errorf("timeline changed: before=%+v after=%+v", beforeTimeline, got)
				}
				if !reflect.DeepEqual(f.events, beforeEvents) {
					t.Errorf("events changed: before=%+v after=%+v", beforeEvents, f.events)
				}
				if !reflect.DeepEqual(f.branches, beforeBranches) {
					t.Errorf("branches changed: before=%+v after=%+v", beforeBranches, f.branches)
				}
				if !reflect.DeepEqual(f.snapshots, beforeSnapshots) {
					t.Errorf("snapshots changed: before=%+v after=%+v", beforeSnapshots, f.snapshots)
				}
			})
		}
	}
}
