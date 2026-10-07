package compose

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

// The host's spawn receipt, not a daemon-supplied principal, owns attribution.
// Keeping it in the existing durable fact store lets a new link replay bursts
// from closed sessions without opening a new process or guessing its member.
func (h *machineHost) Record(ctx context.Context, branch string, boot [16]byte, id uint32, user machined.SessionUser) error {
	if h == nil || h.pool == nil || id == 0 || boot == [16]byte{} || user.Login == "" || user.UID < 20000 {
		return machined.ErrNotReady
	}
	return pgx.BeginFunc(ctx, h.pool, func(tx pgx.Tx) error {
		// Serialize duplicate spawn receipts before touching the durable ledger.
		key := branch + ":" + hex.EncodeToString(boot[:]) + ":" + strconv.FormatUint(uint64(id), 10)
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, key); err != nil {
			return err
		}
		var prior machined.SessionUser
		err := tx.QueryRow(ctx, `SELECT data->>'login',(data->>'uid')::bigint FROM product_job_events WHERE principal_id=$1 AND event_type='branch.session_opened' AND data->>'boot'=$2 AND data->>'session'=$3`, "branch:"+branch, hex.EncodeToString(boot[:]), strconv.FormatUint(uint64(id), 10)).Scan(&prior.Login, &prior.UID)
		if err == nil {
			if prior != user {
				return machined.ErrUnauthorized
			}
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var repository int64
		if err := tx.QueryRow(ctx, `SELECT repository_id FROM workspaces WHERE id=$1`, branch).Scan(&repository); err != nil {
			return err
		}
		data, err := json.Marshal(map[string]any{"boot": hex.EncodeToString(boot[:]), "session": id, "login": user.Login, "uid": user.UID})
		if err != nil {
			return err
		}
		event := uuid.NewSHA1(uuid.UUID(boot), []byte(strconv.FormatUint(uint64(id), 10))).String()
		_, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: fmt.Sprint(repository), PrincipalID: "branch:" + branch}, event, "branch.session_opened", "completed", data)
		return err
	})
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
