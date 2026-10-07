package services

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
)

func TestWikiFolderSyncCadenceIncludesPassDuration(t *testing.T) {
	for _, row := range []struct {
		name string
		work time.Duration
		want []time.Duration
	}{
		{"ordinary", 20 * time.Second, []time.Duration{0, time.Minute, 2 * time.Minute}},
		{"overrun", 90 * time.Second, []time.Duration{0, 90 * time.Second, 3 * time.Minute}},
	} {
		t.Run(row.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				start := time.Now()
				var starts []time.Duration
				runWikiFolderSync(ctx, func(context.Context) map[WikiFolderSync]error {
					starts = append(starts, time.Since(start))
					time.Sleep(row.work)
					if len(starts) == 3 {
						cancel()
					}
					return nil
				}, time.Minute)
				require.Equal(t, row.want, starts)
			})
		})
	}
}

func TestWikiFolderSyncCancellationDuringWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		start := time.Now()
		calls := 0
		go func() {
			time.Sleep(10 * time.Second)
			cancel()
		}()
		runWikiFolderSync(ctx, func(context.Context) map[WikiFolderSync]error {
			calls++
			return nil
		}, time.Minute)
		require.Equal(t, 1, calls)
		require.Equal(t, 10*time.Second, time.Since(start))
	})
}
