package machined

import (
	"context"
	"errors"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestHostObjectsUnavailableAndExclusion(t *testing.T) {
	for _, available := range []bool{false, true} {
		s := HostObjects{}
		failure := ErrNotReady
		calls := 0
		if available {
			failure = errors.New("maintenance exclusion refused")
			s.Visit = func(_ context.Context, branch string, _ func(string) error) error {
				require.Equal(t, "branch", branch)
				calls++
				return failure
			}
		}
		require.ErrorIs(t, s.Import(t.Context(), "branch", nil), failure)
		_, err := s.VerifyCapture(t.Context(), "branch", wire.Captured{})
		require.ErrorIs(t, err, failure)
		_, err = s.PublishCapture(t.Context(), "branch", wire.Captured{})
		require.ErrorIs(t, err, failure)
		_, err = s.VerifyBurst(t.Context(), "branch", wire.Burst{})
		require.ErrorIs(t, err, failure)
		require.ErrorIs(t, s.PublishBurst(t.Context(), "branch", "id", "head"), failure)
		if available {
			require.Equal(t, 5, calls)
		}
	}
}
