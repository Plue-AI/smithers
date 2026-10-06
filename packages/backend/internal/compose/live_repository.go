package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/sse"
	"github.com/smithersai/smithers/packages/backend/jobs"
	"strconv"
	"time"
)

func liveRepositoryTodosSource(source live.Source, store *jobs.Store, repository int64) live.Source {
	tenant := strconv.FormatInt(repository, 10)
	scope := jobs.RepositoryTodosScope(tenant)
	source.Hints = append(source.Hints, "smithers_product_jobs")
	source.Every = 250 * time.Millisecond
	source.RefreshEvery = time.Second
	source.RefreshSnapshot = func(data json.RawMessage) json.RawMessage {
		var fields map[string]json.RawMessage
		if json.Unmarshal(data, &fields) != nil {
			return nil
		}
		delete(fields, "items")
		delete(fields, "counts")
		key, _ := json.Marshal(fields)
		return key
	}
	source.Durable = &sse.DurableStream{
		Head: func(ctx context.Context) (int64, error) { return store.Head(ctx, scope) },
		Validate: func(ctx context.Context, cursor int64) error {
			_, err := store.ReplayRepositoryTodos(ctx, tenant, cursor, 1)
			return liveReplayError(err)
		},
		Load: func(ctx context.Context, after int64, limit int) (sse.DurablePage, error) {
			page, err := store.ReplayRepositoryTodos(ctx, tenant, after, limit)
			if err != nil {
				return sse.DurablePage{}, liveReplayError(err)
			}
			result := sse.DurablePage{Cursor: page.Cursor, More: page.More}
			for _, event := range page.Events {
				data, err := json.Marshal(event)
				if err != nil {
					return sse.DurablePage{}, err
				}
				result.Events = append(result.Events, sse.Event{ID: strconv.FormatInt(event.RepositorySequence, 10), Data: string(data)})
			}
			return result, nil
		},
	}
	source.Snapshot = func(ctx context.Context) (int64, json.RawMessage, error) {
		for attempt := 0; attempt < 5; attempt++ {
			before, err := store.Head(ctx, scope)
			if err != nil {
				return 0, nil, err
			}
			data, err := source.Build(ctx)
			if err != nil {
				return 0, nil, err
			}
			after, err := store.Head(ctx, scope)
			if err != nil {
				return 0, nil, err
			}
			if before == after {
				return after, data, nil
			}
		}
		return 0, nil, fmt.Errorf("Home changed throughout snapshot read")
	}
	return source
}
