package services

import (
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
	"testing"
)

func TestMythicalDirectSlot(t *testing.T) {
	for _, source := range []string{"issue", "chat"} {
		for _, tc := range []struct {
			busy, max int
			want      bool
		}{
			{0, 0, false}, {0, 1, true}, {1, 1, false},
			{1, 2, true}, {2, 2, false}, {3, 2, false}, {7, 8, true},
		} {
			st := mythicalItemStep{busy: tc.busy, maxParallel: tc.max}
			require.Equal(t, tc.want, st.slot(db.MythicalItem{Source: source}))
			st.launches = mythicalLaunchesPerRun
			require.False(t, st.slot(db.MythicalItem{Source: source}))
		}
	}
}
