package compose

import (
	"context"
	"encoding/json"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type machineBurstStore struct{ host *repohost.Client }

func (s machineBurstStore) WithBurstObjects(ctx context.Context, tx pgx.Tx, branch string, visit func(machined.BurstObjects) error) error {
	return withMachineRepositoryTx(ctx, tx, branch, s.host, func(path string) error {
		return visit(machined.GitBurstObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }})
	})
}

func machineEventActor(ctx context.Context, presence *branchPresence, link *machined.Link, branch string, actor wire.Actor) (json.RawMessage, error) {
	if actor.Kind == 4 {
		return json.RawMessage(`{"kind":"outside","color_index":7}`), nil
	}
	if presence == nil || presence.queries == nil || link == nil {
		return nil, machined.ErrNotReady
	}
	var binding presenceSessionBinding
	var err error
	switch actor.Kind {
	case 2:
		binding, err = presence.sessionResolver(link)(ctx, branch, actor.Session)
	case 3:
		var via string
		via, err = link.RunPresence(branch, actor.Run)
		if err == nil {
			binding, err = presence.agentSessionBinding(ctx, branch, actor.Run, via)
		}
	default:
		// Host principal bytes need the write/document door's admission registry.
		// Never treat guest-supplied bytes as a member or relabel them as outside.
		return nil, machined.ErrNotReady
	}
	if err != nil {
		return nil, err
	}
	if binding.Skip || !validPresenceBinding(binding) {
		return nil, machined.ErrUnauthorized
	}
	value := map[string]any{"kind": binding.Kind, "via": binding.Via}
	if binding.Kind == "person" {
		id := strconv.FormatInt(binding.Member, 10)
		value["id"], value["member_id"] = "member:"+id, id
	} else {
		value["id"], value["run_id"], value["agent_kind"], value["name"] = binding.Participant, binding.Run, binding.AgentKind, binding.Name
		if binding.Member > 0 {
			value["for_member"] = strconv.FormatInt(binding.Member, 10)
		}
	}
	return json.Marshal(value)
}

func bindMachineEvents(ctx context.Context, registry *machined.Registry, pool *pgxpool.Pool, host *repohost.Client, presence *branchPresence) (func(), error) {
	if registry == nil {
		return func() {}, nil
	}
	if pool == nil || host == nil {
		return nil, machined.ErrNotReady
	}
	burst := func(link *machined.Link) *machined.BurstIngest {
		return &machined.BurstIngest{Pool: pool, Objects: machineBurstStore{host}, ResolveActor: func(ctx context.Context, branch string, actor wire.Actor) (json.RawMessage, error) {
			return machineEventActor(ctx, presence, link, branch, actor)
		}}
	}
	return registry.ConsumeEvents(ctx, func(ctx context.Context, link *machined.Link, branch string, event machined.Event) (machined.Acknowledgement, error) {
		ingest := &machined.Ingestor{Pool: pool, Bursts: burst(link), Prepare: func(ctx context.Context, tx pgx.Tx, branch string, event machined.Event) (machined.EventWriter, error) {
			if len(event.Payload) == 0 || event.Payload[0] != 2 {
				return nil, machined.ErrNotReady
			}
			return prepareMachineCaptureWriter(host)(ctx, tx, branch, event)
		}}
		return ingest.Commit(ctx, link.Connection, branch, event)
	}, func(ctx context.Context, link *machined.Link, branch string, event machined.Event) error {
		return burst(link).Hint(ctx, link.Connection, branch, event)
	})
}

func machineBranchHead(pool *pgxpool.Pool, host *repohost.Client) func(context.Context, string) (string, error) {
	return func(ctx context.Context, branch string) (string, error) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			return "", err
		}
		defer tx.Rollback(ctx)
		var head string
		err = withMachineRepositoryTx(ctx, tx, branch, host, func(path string) error {
			objects := machined.GitCaptureObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }}
			var readErr error
			head, readErr = objects.BranchHead(ctx, branch)
			return readErr
		})
		return head, err
	}
}
