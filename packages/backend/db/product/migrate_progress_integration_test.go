package product

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

// A fresh install's first boot applies every migration in one transaction
// (116 took 29.5 s at load 67 on the real-GitHub walk); Apply reports each
// step so the install's starting page and the launcher see progress.
func TestApplyReportsEachPendingMigration(t *testing.T) {
	pool := newProductTestPool(t)
	ctx := context.Background()
	registered, err := registeredMigrations()
	require.NoError(t, err)

	var steps [][2]int
	require.NoError(t, Apply(WithMigrationProgress(ctx, func(done, total int) {
		steps = append(steps, [2]int{done, total})
	}), pool))
	require.Len(t, steps, len(registered)+1, "a first report, then one per migration")
	for i, step := range steps {
		require.Equal(t, [2]int{i, len(registered)}, step)
	}

	// A migrated database has nothing pending: one report of 0 of 0.
	steps = nil
	require.NoError(t, Apply(WithMigrationProgress(ctx, func(done, total int) {
		steps = append(steps, [2]int{done, total})
	}), pool))
	require.Equal(t, [][2]int{{0, 0}}, steps)

	// Without a receiver Apply reports nothing and still migrates.
	require.NoError(t, Apply(ctx, pool))
}
