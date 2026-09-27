package jobs

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Claims compare next_attempt_at with PostgreSQL's clock_timestamp(). An
// unscheduled admission used the admitting process's clock, so an API host
// running ahead of the database left fresh work unclaimable ("no work
// available") until the database caught up.
func TestUnscheduledAdmissionIsAvailableOnTheDatabaseClock(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	receipt, err := store.Admit(ctx, testAdmission(Scope{TenantID: "tenant", PrincipalID: "owner"}, "clock", EffectIdempotent, `{}`))
	require.NoError(t, err)
	var admittedAt, availableAt time.Time
	require.NoError(t, store.pool.QueryRow(ctx, `
		SELECT request.created_at, dispatch.next_attempt_at
		FROM product_job_requests request
		JOIN product_job_dispatches dispatch ON dispatch.operation_id = request.id
		WHERE request.id = $1`, receipt.OperationID).Scan(&admittedAt, &availableAt))
	require.False(t, availableAt.Before(admittedAt),
		"next_attempt_at %s precedes the database admission time %s: it came from another clock", availableAt, admittedAt)
	claim, err := store.Claim(ctx, "worker", time.Minute)
	require.NoError(t, err)
	require.Equal(t, receipt.OperationID, claim.OperationID)
}
