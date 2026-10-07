package compose

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// The host's spawn receipt, not a daemon-supplied principal, owns attribution.
// Keeping it in the existing durable fact store lets a new link replay bursts
// from closed sessions without opening a new process or guessing its member.
func (h *machineHost) Record(ctx context.Context, branch string, boot [16]byte, id uint32, user machined.SessionUser, via string) error {
	if h == nil || h.pool == nil || id == 0 || boot == [16]byte{} || user.Login == "" || (user.UID < 20000 && !(user.Login == "agent" && user.UID == 19999)) {
		return machined.ErrNotReady
	}
	if via == "" {
		via = "terminal"
	}
	if via != "terminal" && via != "ssh" && via != "cli" && !strings.HasPrefix(via, "agent:") {
		return machined.ErrUnauthorized
	}
	write := func(tx pgx.Tx) error {
		// Serialize duplicate spawn receipts before touching the durable ledger.
		key := branch + ":" + hex.EncodeToString(boot[:]) + ":" + strconv.FormatUint(uint64(id), 10)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
			return err
		}
		var prior machined.SessionUser
		var priorVia string
		err := tx.QueryRow(ctx, `SELECT data->>'login',(data->>'uid')::bigint,COALESCE(data->>'via','terminal') FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened' AND data->>'boot'=$2 AND data->>'session'=$3`, "branch:"+branch, hex.EncodeToString(boot[:]), strconv.FormatUint(uint64(id), 10)).Scan(&prior.Login, &prior.UID, &priorVia)
		if err == nil {
			if prior != user || priorVia != via {
				return machined.ErrUnauthorized
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var member, generation int64
		var actor map[string]any
		if user.Login == "agent" && user.UID == 19999 {
			host := strings.TrimPrefix(via, "agent:")
			parsed, e := uuid.Parse(host)
			if e != nil || parsed.String() != host {
				return machined.ErrUnauthorized
			}
			if err := tx.QueryRow(ctx, `SELECT h.user_id,h.owner_generation FROM flow_runtime_host_bindings h JOIN workspaces w ON w.id=h.workspace_id JOIN users u ON u.id=h.user_id JOIN collaborators c ON c.repository_id=w.repository_id AND c.user_id=u.id WHERE h.id=$1 AND w.id=$2 AND w.kind='vm' AND w.deleted_at IS NULL AND w.status='running' AND h.catalog_key='coding' AND h.state IN ('pending','starting','running') AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND c.unix_uid>=20000 AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL FOR SHARE OF h,w,c,u`, host, branch).Scan(&member, &generation); err != nil {
				return machined.ErrUnauthorized
			}
			actor = map[string]any{"id": "agent:" + host, "kind": "agent", "agent": "coding", "run_id": host, "member_id": strconv.FormatInt(member, 10)}
		} else {
			if strings.HasPrefix(via, "agent:") {
				return machined.ErrUnauthorized
			}
			if err := tx.QueryRow(ctx, `SELECT c.user_id FROM collaborators c JOIN workspaces w ON w.repository_id=c.repository_id JOIN users u ON u.id=c.user_id WHERE w.id=$1 AND c.unix_login=$2 AND c.unix_uid=$3 AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND u.is_active AND u.deleted_at IS NULL AND NOT u.prohibit_login FOR SHARE OF c,u`, branch, user.Login, user.UID).Scan(&member); err != nil {
				return machined.ErrUnauthorized
			}
			actor = map[string]any{"id": "member:" + strconv.FormatInt(member, 10), "kind": "person", "member_id": strconv.FormatInt(member, 10), "via": via}
		}

		var repository int64
		if err := tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository); err != nil {
			return err
		}
		data, err := json.Marshal(map[string]any{"boot": hex.EncodeToString(boot[:]), "session": id, "login": user.Login, "uid": user.UID, "member_id": member, "via": via, "actor": actor, "owner_generation": generation})
		if err != nil {
			return err
		}
		event := uuid.NewSHA1(uuid.UUID(boot), []byte(strconv.FormatUint(uint64(id), 10))).String()
		_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, event, "branch.session_opened", "completed", data)
		return err
	}
	if tx := machined.SessionAdmissionTransaction(ctx, branch); tx != nil {
		return write(tx)
	}
	return pgx.BeginFunc(ctx, h.pool, write)
}
func (h *machineHost) Lookup(ctx context.Context, branch string, boot [16]byte, id uint32) (machined.SessionUser, error) {
	if h == nil || h.pool == nil || id == 0 {
		return machined.SessionUser{}, machined.ErrNotReady
	}
	var user machined.SessionUser
	err := h.pool.QueryRow(ctx, `SELECT data->>'login',(data->>'uid')::bigint FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened' AND data->>'boot'=$2 AND data->>'session'=$3`, "branch:"+branch, hex.EncodeToString(boot[:]), strconv.FormatUint(uint64(id), 10)).Scan(&user.Login, &user.UID)
	if errors.Is(err, pgx.ErrNoRows) {
		return machined.SessionUser{}, machined.ErrNotReady
	}
	if err != nil {
		return machined.SessionUser{}, err
	}
	return user, nil
}

func (h *machineHost) Attribution(ctx context.Context, branch string, boot [16]byte, id uint32) (json.RawMessage, error) {
	var actor json.RawMessage
	err := h.pool.QueryRow(ctx, `SELECT data->'actor' FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened' AND data->>'boot'=$2 AND data->>'session'=$3`, "branch:"+branch, hex.EncodeToString(boot[:]), strconv.FormatUint(uint64(id), 10)).Scan(&actor)
	if err != nil || len(actor) == 0 {
		return nil, machined.ErrNotReady
	}
	return actor, nil
}
func (h *machineHost) agentActor(ctx context.Context, branch string, boot [16]byte, run string) (json.RawMessage, error) {
	var actor json.RawMessage
	err := h.pool.QueryRow(ctx, `SELECT data->'actor' FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened' AND data->>'boot'=$2 AND data->>'via'=$3 ORDER BY sequence DESC LIMIT 1`, "branch:"+branch, hex.EncodeToString(boot[:]), "agent:"+run).Scan(&actor)
	if err != nil || len(actor) == 0 {
		return nil, machined.ErrNotReady
	}
	return actor, nil
}

// Hold row locks through spawn so member suspension or host ownership transfer
// cannot complete between authorization and the durable session/run binding.
func (h *machineHost) admitAgent(ctx context.Context, branch, host string, spawn func(context.Context) error) error {
	if h == nil || h.pool == nil || spawn == nil {
		return machined.ErrNotReady
	}
	id, err := uuid.Parse(host)
	if err != nil || id.String() != host {
		return machined.ErrUnauthorized
	}
	return pgx.BeginFunc(ctx, h.pool, func(tx pgx.Tx) error {
		var member int64
		if err := tx.QueryRow(ctx, `SELECT h.user_id FROM flow_runtime_host_bindings h JOIN workspaces w ON w.id=h.workspace_id JOIN users u ON u.id=h.user_id JOIN collaborators c ON c.repository_id=w.repository_id AND c.user_id=u.id WHERE h.id=$1 AND w.id=$2 AND w.kind='vm' AND w.deleted_at IS NULL AND w.status='running' AND h.catalog_key='coding' AND h.state IN ('pending','starting','running') AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND c.unix_uid>=20000 AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL FOR SHARE OF h,w,c,u`, host, branch).Scan(&member); err != nil {
			return machined.ErrUnauthorized
		}
		return spawn(machined.WithSessionAdmissionTransaction(ctx, branch, tx))
	})
}

// Commit run attribution before acquiring the live spawn locks. The subsequent
// admission still rechecks the current host and member; the reference grants no access.
func (h *machineHost) commitAgentActor(ctx context.Context, branch, machine, host string) ([]byte, error) {
	if h == nil || h.pool == nil {
		return nil, machined.ErrNotReady
	}
	return machined.CommitActor(ctx, h.pool, branch, machine, func(ctx context.Context, tx pgx.Tx) (machined.ActorIdentity, error) {
		var member int64
		if err := tx.QueryRow(ctx, `SELECT h.user_id FROM flow_runtime_host_bindings h JOIN workspaces w ON w.id=h.workspace_id JOIN users u ON u.id=h.user_id JOIN collaborators c ON c.repository_id=w.repository_id AND c.user_id=u.id WHERE h.id=$1 AND w.id=$2 AND w.vm_id=$3 AND w.kind='vm' AND w.deleted_at IS NULL AND w.status='running' AND h.catalog_key='coding' AND h.state IN ('pending','starting','running') AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND c.unix_uid>=20000 AND u.is_active AND NOT u.prohibit_login AND u.deleted_at IS NULL FOR SHARE OF h,w,c,u`, host, branch, machine).Scan(&member); err != nil {
			return machined.ActorIdentity{}, machined.ErrUnauthorized
		}
		return machined.ActorIdentity{Kind: "agent", MemberID: member, Run: host, AgentKind: "coding", Via: "agent"}, nil
	})
}
