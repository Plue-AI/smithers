package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/stretchr/testify/require"
)

type awakeCaptureFunc func(context.Context, string) (machined.CaptureResult, error)

func (f awakeCaptureFunc) Capture(ctx context.Context, id string) (machined.CaptureResult, error) {
	return f(ctx, id)
}

func TestAwakeBranchCaptureSettles(t *testing.T) {
	t.Run("draining delivery retries then returns the acknowledged capture", func(t *testing.T) {
		calls := 0
		expected := machined.CaptureResult{Head: "acknowledged"}
		actual, err := captureAwakeBranch(t.Context(), awakeCaptureFunc(func(ctx context.Context, id string) (machined.CaptureResult, error) {
			require.Equal(t, "branch", id)
			require.NoError(t, ctx.Err())
			calls++
			if calls == 1 {
				return machined.CaptureResult{}, machined.ErrNotReady
			}
			return expected, nil
		}), "branch")
		require.NoError(t, err)
		require.Equal(t, expected, actual)
		require.Equal(t, 2, calls)
	})
	for _, failure := range []error{machined.ErrUnauthorized, errors.New("object transport failed")} {
		t.Run(failure.Error(), func(t *testing.T) {
			calls := 0
			_, err := captureAwakeBranch(t.Context(), awakeCaptureFunc(func(context.Context, string) (machined.CaptureResult, error) {
				calls++
				return machined.CaptureResult{}, failure
			}), "branch")
			require.ErrorIs(t, err, failure)
			require.Equal(t, 1, calls)
		})
	}
	t.Run("canceled request never captures", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		calls := 0
		_, err := captureAwakeBranch(ctx, awakeCaptureFunc(func(context.Context, string) (machined.CaptureResult, error) {
			calls++
			return machined.CaptureResult{}, nil
		}), "branch")
		require.ErrorIs(t, err, context.Canceled)
		require.Zero(t, calls)
	})
	t.Run("cancellation interrupts a draining capture", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		defer cancel()
		calls := 0
		_, err := captureAwakeBranch(ctx, awakeCaptureFunc(func(context.Context, string) (machined.CaptureResult, error) {
			calls++
			cancel()
			return machined.CaptureResult{}, machined.ErrNotReady
		}), "branch")
		require.ErrorIs(t, err, context.Canceled)
		require.Equal(t, 1, calls)
	})
	t.Run("request deadline bounds readiness retry", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
		defer cancel()
		calls := 0
		_, err := captureAwakeBranch(ctx, awakeCaptureFunc(func(context.Context, string) (machined.CaptureResult, error) {
			calls++
			return machined.CaptureResult{}, machined.ErrNotReady
		}), "branch")
		require.ErrorIs(t, err, context.DeadlineExceeded)
		require.Equal(t, 1, calls)
	})
}
