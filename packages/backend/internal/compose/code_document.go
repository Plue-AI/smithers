package compose

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"net/http"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/live"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// composeCodeDocumentRelay binds the relay to member admission and the
// authenticated daemon link. Documents live in the daemon (ADR 0003); the host
// runs no document core for code and has no alternate file writer.
func composeCodeDocumentRelay(workspaces *services.WorkspaceService, registry *machined.Registry) *live.DocRelay {
	if workspaces == nil || registry == nil {
		return nil
	}
	return &live.DocRelay{
		Authorize: func(ctx context.Context, topic live.DocumentTopic, repository, member int64) ([]byte, string) {
			actor, err := workspaces.AdmitCodeDocument(ctx, topic.Branch, topic.Path, repository, member)
			if err != nil {
				var api *pkgerrors.APIError
				if errors.Is(err, machined.ErrNotReady) || errors.As(err, &api) && api.Status == http.StatusServiceUnavailable {
					return nil, live.Unsupported
				}
				return nil, live.Forbidden
			}
			link, err := registry.Current(topic.Branch)
			if err != nil {
				return nil, live.Unsupported
			}
			if err := link.Connection.RequireMachine(topic.Branch, actor.MachineID); err != nil {
				return nil, live.Unsupported
			}
			return actor.Reference, ""
		},
		Connection: func(_ context.Context, branch string) (*machined.Connection, live.DocumentRPC) {
			link, err := registry.Current(branch)
			if err != nil {
				return nil, nil
			}
			return link.Connection, machined.Documents(registry, branch)
		},
	}
}

// Resolve display attribution from immutable host records under the admitted
// branch and current machine. No document bytes are parsed or changed here.
func (t *liveTopics) codeDocumentAuthors(pool *pgxpool.Pool) func(context.Context, live.DocumentTopic) (map[string]json.RawMessage, error) {
	return func(ctx context.Context, topic live.DocumentTopic) (map[string]json.RawMessage, error) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return nil, err
		}
		defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
		rows, err := tx.Query(ctx, `SELECT r.id::text, r.machine_id FROM machine_actor_references r JOIN workspaces w ON w.id=r.workspace_id WHERE w.id=$1 AND w.deleted_at IS NULL`, topic.Branch)
		if err != nil {
			return nil, err
		}
		type reference struct{ key, machine string }
		var references []reference
		for rows.Next() {
			var r reference
			if err := rows.Scan(&r.key, &r.machine); err != nil {
				rows.Close()
				return nil, err
			}
			references = append(references, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		raw := map[string]json.RawMessage{"outside": json.RawMessage(`{"kind":"outside","color_index":7}`)}
		for _, r := range references {
			key := strings.ReplaceAll(r.key, "-", "")
			bytes, err := hex.DecodeString(key)
			if err != nil {
				return nil, err
			}
			actor, err := machined.ResolveStoredEventActor(ctx, tx, topic.Branch, r.machine, wire.Actor{Kind: 1, Principal: bytes})
			if err != nil {
				return nil, err
			}
			raw[key] = actor
		}
		if err := tx.Rollback(ctx); err != nil {
			return nil, err
		}
		resolve := t.changeActorResolver(ctx)
		for key, actor := range raw {
			rendered, err := resolve(actor)
			if err != nil {
				return nil, err
			}
			raw[key] = rendered
		}
		return raw, nil
	}
}
