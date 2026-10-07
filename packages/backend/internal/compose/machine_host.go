package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

type machineHost struct {
	pool       *pgxpool.Pool
	repository *repohost.Client
	objects    machined.HostObjects
}

func newMachineHost(pool *pgxpool.Pool, repository *repohost.Client) *machineHost {
	return &machineHost{pool: pool, repository: repository, objects: machineObjects(pool, repository)}
}
func (h *machineHost) head(ctx context.Context, branch string) (string, error) {
	row, err := db.New(h.pool).GetWorkspace(ctx, branch)
	if err != nil {
		return "", err
	}
	if row.HeadPushTokenID.Valid {
		return "", machined.ErrNotReady
	}
	seed := row.HeadCommitID
	if seed == "" {
		seed = row.SourceCommit
	}
	return h.objects.Head(ctx, branch, seed)
}
func (h *machineHost) dispatch(ctx context.Context, link *machined.Link, branch string) error {
	row, err := db.New(h.pool).GetWorkspace(ctx, branch)
	if err != nil {
		return err
	}
	scope := jobs.Scope{TenantID: fmt.Sprint(row.RepositoryID), PrincipalID: "branch:" + branch}
	ingest := &machined.Ingestor{Pool: h.pool, Prepare: prepareMachineCaptureWriter(h.repository)}
	bursts := &machined.BurstIngest{Pool: h.pool, VisitObjects: func(ctx context.Context, tx pgx.Tx, branch string, visit func(machined.BurstObjects) error) error {
		return withMachineRepositoryTx(ctx, tx, branch, h.repository, func(path string) error {
			return visit(machined.GitBurstObjects{Resolve: func(context.Context, string) (string, error) { return path, nil }})
		})
	}, ResolveActor: func(ctx context.Context, branch string, actor wire.Actor) (json.RawMessage, error) {
		var member int64
		via := "app"
		switch actor.Kind {
		case 1:
			principal := string(actor.Principal)
			if !strings.HasPrefix(principal, "member:") {
				return nil, machined.ErrUnauthorized
			}
			var err error
			member, err = strconv.ParseInt(strings.TrimPrefix(principal, "member:"), 10, 64)
			if err != nil || member <= 0 {
				return nil, machined.ErrUnauthorized
			}
		case 2:
			user, err := link.SessionIdentity(ctx, actor.Session)
			if err != nil {
				return nil, err
			}
			err = h.pool.QueryRow(ctx, `SELECT c.user_id FROM collaborators c JOIN workspaces w ON w.repository_id=c.repository_id WHERE w.id=$1 AND c.unix_login=$2 AND c.unix_uid=$3 AND c.suspended_at IS NULL AND c.permission IN ('admin','write')`, branch, user.Login, user.UID).Scan(&member)
			if err != nil {
				return nil, err
			}
			via = "terminal"
		default:
			return nil, machined.ErrNotReady
		}
		var allowed bool
		if err := h.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM collaborators c JOIN workspaces w ON w.repository_id=c.repository_id JOIN users u ON u.id=c.user_id WHERE w.id=$1 AND c.user_id=$2 AND c.suspended_at IS NULL AND c.permission IN ('admin','write') AND NOT u.prohibit_login)`, branch, member).Scan(&allowed); err != nil {
			return nil, err
		}
		if !allowed {
			return nil, machined.ErrUnauthorized
		}
		return json.Marshal(map[string]any{"id": "member:" + strconv.FormatInt(member, 10), "kind": "person", "member_id": strconv.FormatInt(member, 10), "via": via})
	}}
	for {
		event, err := link.Receive(ctx)
		if err != nil {
			return err
		}
		if event.Seq == 0 {
			continue
		}
		if len(event.Payload) == 0 {
			return wire.BadValue
		}
		switch event.Payload[0] {
		case 1:
			if err = bursts.DispatchBurst(ctx, link, scope, event); err != nil {
				return err
			}
		case 2, 3:
			ack, err := ingest.Commit(ctx, link.Connection, branch, event)
			if err != nil {
				return err
			}
			if err = link.Ack(ctx, branch, ack); err != nil {
				return err
			}
		default:
			// Unsupported durable events retain their guest outbox and object pins.
			return machined.ErrNotReady
		}
	}
}
