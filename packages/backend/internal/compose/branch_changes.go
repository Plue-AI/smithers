package compose

import (
	"context"
	"encoding/json"
	"errors"
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
		rows, err := t.changePool.Query(ctx, `SELECT DISTINCT ON(f.path) jsonb_strip_nulls(jsonb_build_object('path',f.path,'change',f.change,'renamed_to',f.renamed_to,'last_writer',e.data->'actor','post_digest',COALESCE(f.post_digest,'absent'))) FROM burst_files f JOIN product_job_events e ON e.event_id=f.event_id WHERE e.tenant_id=$1 AND e.principal_id=$2 ORDER BY f.path,e.sequence DESC`, strconv.FormatInt(repository, 10), "branch:"+row.ID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		changed := []json.RawMessage{}
		actor := t.changeActorResolver(ctx)
		for rows.Next() {
			var data json.RawMessage
			if err := rows.Scan(&data); err != nil {
				return nil, err
			}
			var file map[string]json.RawMessage
			if err := json.Unmarshal(data, &file); err != nil {
				return nil, err
			}
			file["last_writer"], err = actor(file["last_writer"])
			if err != nil {
				return nil, err
			}
			data, err = json.Marshal(file)
			if err != nil {
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
	rows, err := t.changePool.Query(ctx, `SELECT sequence,jsonb_build_object('id',data->>'id','at',to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'kind',data->>'kind','actor',data->'actor','files',COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('path',f.path,'change',f.change,'before_blob',f.before_blob,'after_blob',f.after_blob)) ORDER BY f.path) FROM burst_files f WHERE f.event_id=e.event_id),'[]'::jsonb),'versions',data->>'versions') FROM product_job_events e WHERE tenant_id=$1 AND principal_id=$2 AND event_type='branch.burst'`+selector+` ORDER BY sequence `+order, args...)
	if err != nil {
		return live.LogPage{}, err
	}
	defer rows.Close()
	entries := []json.RawMessage{}
	actor := t.changeActorResolver(ctx)
	for rows.Next() {
		var seq int64
		var data json.RawMessage
		if err := rows.Scan(&seq, &data); err != nil {
			return live.LogPage{}, err
		}
		if seq > cursor {
			cursor = seq
		}
		var entry map[string]json.RawMessage
		if err := json.Unmarshal(data, &entry); err != nil {
			return live.LogPage{}, err
		}
		entry["actor"], err = actor(entry["actor"])
		if err != nil {
			return live.LogPage{}, err
		}
		data, err = json.Marshal(entry)
		if err != nil {
			return live.LogPage{}, err
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

// Resolve durable numeric member IDs through the existing identity and roster
// providers. This is attribution only; branch authority precedes every read.
func (t *liveTopics) changeActorResolver(ctx context.Context) func(json.RawMessage) (json.RawMessage, error) {
	cache := map[string]json.RawMessage{}
	colors := map[string]int{}
	loaded := false
	return func(raw json.RawMessage) (json.RawMessage, error) {
		if cached, ok := cache[string(raw)]; ok {
			return cached, nil
		}
		var participant struct {
			Kind   string `json:"kind"`
			ID     string `json:"id"`
			Member string `json:"member_id"`
			Via    string `json:"via"`
			Login  string `json:"login"`
		}
		if err := json.Unmarshal(raw, &participant); err != nil {
			return nil, err
		}
		if participant.Kind != "person" || participant.Login != "" {
			return raw, nil
		}
		if t.presence == nil || t.presence.queries == nil {
			return nil, errors.New("branch actors unavailable")
		}
		id := participant.Member
		if id == "" {
			id = participant.ID
		}
		member, err := strconv.ParseInt(strings.TrimPrefix(id, "member:"), 10, 64)
		if err != nil {
			return nil, err
		}
		person, err := t.presence.queries.GetUserByID(ctx, member)
		if err != nil {
			return nil, err
		}
		if !loaded && t.presence.members != nil {
			roster, err := t.presence.members.SharedRoster(ctx)
			if err != nil {
				return nil, err
			}
			for _, row := range roster.Members {
				colors[row.Login] = row.ColorIndex
			}
			loaded = true
		}
		actor := branchPersonActor(person, colors[person.Username])
		actor["id"], actor["member_id"] = participant.ID, participant.Member
		if participant.Via == "ssh" || participant.Via == "terminal" || participant.Via == "cli" {
			actor["via"] = participant.Via
		}
		rendered, err := json.Marshal(actor)
		if err == nil {
			cache[string(raw)] = rendered
		}
		return rendered, err
	}
}
