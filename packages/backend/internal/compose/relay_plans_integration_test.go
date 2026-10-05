package compose

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/flowruntime"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

// Fable round 3 N2, Astra round 3 N1: the browser relay's saved plans live
// in PostgreSQL, so a plan one backend replica saved is known to every
// replica, for the same caller and box only, and is forgotten after a day
// (a later save prunes it).
func TestRelayPlanStoreKeepsPlansPerCallerAndBox(t *testing.T) {
	ctx := context.Background()
	pool, _ := postgresfixture.NewProductDatabase(t)
	one, two := relayPlanStore{db.New(pool)}, relayPlanStore{db.New(pool)}
	box := flowruntime.Target{TenantID: "repository:1", PrincipalID: "user:1", WorkspaceID: "box"}
	require.NoError(t, one.SaveRelayPlan(ctx, box, "plan-1", "coding/dispatch"))

	flow, ok, err := two.RelayPlanFlow(ctx, box, "plan-1")
	require.NoError(t, err)
	require.True(t, ok, "another replica knows the plan")
	require.Equal(t, "coding/dispatch", flow)
	for name, target := range map[string]flowruntime.Target{
		"another caller": {TenantID: box.TenantID, PrincipalID: "user:2", WorkspaceID: box.WorkspaceID},
		"another box":    {TenantID: box.TenantID, PrincipalID: box.PrincipalID, WorkspaceID: "other-box"},
	} {
		_, ok, err := two.RelayPlanFlow(ctx, target, "plan-1")
		require.NoError(t, err)
		require.False(t, ok, name)
	}
	_, ok, err = two.RelayPlanFlow(ctx, box, "plan-unknown")
	require.NoError(t, err)
	require.False(t, ok)

	_, err = pool.Exec(ctx, `UPDATE flow_relay_plans SET created_at = NOW() - INTERVAL '2 days' WHERE plan_id = 'plan-1'`)
	require.NoError(t, err)
	_, ok, err = two.RelayPlanFlow(ctx, box, "plan-1")
	require.NoError(t, err)
	require.False(t, ok, "a day-old plan is forgotten")
	require.NoError(t, one.SaveRelayPlan(ctx, box, "plan-2", "coding/dispatch"))
	var rows int
	require.NoError(t, pool.QueryRow(ctx, `SELECT COUNT(*) FROM flow_relay_plans WHERE plan_id = 'plan-1'`).Scan(&rows))
	require.Zero(t, rows, "a later save prunes it")
}
