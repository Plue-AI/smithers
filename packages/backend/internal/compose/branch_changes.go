package compose

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/live"
)

// Change projections read host-held versions while the branch sleeps. The
// same branch membership check used by presence precedes every rebuild.
func (t *liveTopics) branchChanges(ctx context.Context, topic string, repository, member int64) (live.Source, string) {
	if t.changePool == nil || t.presence == nil || t.presence.branches == nil {
		return live.Source{}, live.Unsupported
	}
	branch, kind, _ := strings.Cut(strings.TrimPrefix(topic, "branch:"), ":")
	if kind != "activity" && kind != "files" {
		return live.Source{}, live.UnknownTopic
	}
	row, err := t.presence.branches.PresenceBranch(ctx, branch, repository, member)
	if err != nil {
		return live.Source{}, live.Forbidden
	}
	channel := "branch_" + strings.ReplaceAll(row.ID, "-", "") + "_" + kind
	if kind == "activity" {
		return live.Source{Key: "branch:" + row.ID + ":activity", Hints: []string{channel}, Every: time.Second, Log: &live.LogSource{Page: func(ctx context.Context, after *int64) (live.LogPage, error) {
			if _, err := t.presence.branches.PresenceBranch(ctx, row.ID, repository, member); err != nil {
				return live.LogPage{}, err
			}
			return t.branchActivityPage(ctx, repository, row.ID, after)
		}}}, ""
	}
	return live.Source{Key: "branch:" + row.ID + ":" + kind, Hints: []string{channel}, Every: time.Second, FailClosed: true, Build: func(ctx context.Context) (json.RawMessage, error) {
		if _, err := t.presence.branches.PresenceBranch(ctx, row.ID, repository, member); err != nil {
			return nil, err
		}
		rows, err := t.changePool.Query(ctx, `SELECT DISTINCT ON(f.path) jsonb_strip_nulls(jsonb_build_object('path',f.path,'change',f.change,'renamed_to',f.renamed_to,'last_writer',e.data->'actor')) FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.tenant_id=$1 AND e.principal_id=$2 ORDER BY f.path,e.sequence DESC`, strconv.FormatInt(repository, 10), "branch:"+row.ID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		changed := []json.RawMessage{}
		for rows.Next() {
			var data json.RawMessage
			if err := rows.Scan(&data); err != nil {
				return nil, err
			}
			changed = append(changed, data)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
		return json.Marshal(map[string]any{"changed": changed, "open": []any{}})
	}}, ""
}

func (t *liveTopics) branchActivityPage(ctx context.Context, repository int64, branch string, after *int64) (live.LogPage, error) {
	tenant, principal := strconv.FormatInt(repository, 10), "branch:"+branch
	cursor := int64(0)
	if after != nil {
		cursor = *after
		if cursor > 0 {
			var exists bool
			if err := t.changePool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_events WHERE tenant_id=$1 AND principal_id=$2 AND sequence=$3 AND event_type='branch.burst')`, tenant, principal, cursor).Scan(&exists); err != nil {
				return live.LogPage{}, err
			}
			if !exists {
				return live.LogPage{Gap: true}, nil
			}
		}
	}
	order := "DESC LIMIT 200"
	selector := ""
	args := []any{tenant, principal}
	if after != nil {
		order = "ASC LIMIT 201"
		selector = " AND sequence>$3"
		args = append(args, cursor)
	}
	rows, err := t.changePool.Query(ctx, `SELECT sequence,jsonb_build_object('id',data->>'id','at',recorded_at,'kind',data->>'kind','actor',data->'actor','files',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('path',f.path,'change',f.change,'before_blob',f.before_blob,'after_blob',f.after_blob)) ORDER BY f.path) FROM burst_files f WHERE f.event_id=e.event_id),'[]'::jsonb),'versions',data->>'versions') FROM product_job_events e WHERE tenant_id=$1 AND principal_id=$2 AND event_type='branch.burst'`+selector+` ORDER BY sequence `+order, args...)
	if err != nil {
		return live.LogPage{}, err
	}
	defer rows.Close()
	entries := []json.RawMessage{}
	for rows.Next() {
		var seq int64
		var data json.RawMessage
		if err := rows.Scan(&seq, &data); err != nil {
			return live.LogPage{}, err
		}
		if seq > cursor {
			cursor = seq
		}
		entries = append(entries, data)
	}
	if err := rows.Err(); err != nil {
		return live.LogPage{}, err
	}
	if len(entries) > 200 {
		return live.LogPage{Gap: true}, nil
	}
	if after == nil {
		for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
			entries[i], entries[j] = entries[j], entries[i]
		}
	}
	data, err := json.Marshal(entries)
	return live.LogPage{Cursor: cursor, Data: data}, err
}
