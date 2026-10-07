package services

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/jobs"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The existing owner fence and updated_by attribution protect the setting.
// Release only this gate's delay: the ordinary worker rechecks every other gate.
func (s *InstallSetupService) SetTodoDailyAdmissions(ctx context.Context, actor int64, value int64) error {
	info := middleware.AuthInfoFromContext(ctx)
	if info == nil || info.User == nil || info.User.ID != actor || info.SessionHash == "" || info.IsTokenAuth || info.IsAgent() {
		return pkgerrors.Forbidden("install owner session required")
	}
	if value < 1 {
		return &InstallReadinessError{Code: "invalid_daily_admissions", Class: "user", Message: "TODOs per day must be a positive integer"}
	}
	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('todo_daily_admissions', 0))`); err != nil {
		return err
	}
	raw, _ := json.Marshal(value)
	result, err := tx.Exec(ctx, `INSERT INTO install_settings(key,value,updated_by) SELECT 'todo_daily_admissions',$1,$2 FROM self_host_owners WHERE user_id=$2 ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`, raw, actor)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return pkgerrors.Forbidden("install owner session required")
	}
	if _, err = tx.Exec(ctx, `WITH released AS (UPDATE mythical_items SET next_attempt_at=now(),version=version+1 WHERE reason=$1 AND state IN ('queued','retrying','skipped') RETURNING repository_id) UPDATE mythical_stacks SET requested_generation=requested_generation+1,next_attempt_at=now() WHERE repository_id IN (SELECT repository_id FROM released)`, todoDailyLimitReason); err != nil {
		return err
	}
	fact, _ := json.Marshal(map[string]any{"actor_user_id": actor, "todo_daily_admissions": value})
	if _, err = jobs.RecordFactInTx(ctx, tx, jobs.Scope{TenantID: "install", PrincipalID: fmt.Sprintf("user:%d", actor)}, uuid.NewString(), "settings.daily-admissions", "saved", fact); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
