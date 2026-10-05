package services

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type syncReceiptFixture struct {
	rows                           []db.GithubMainPull
	listErr, discoverErr, retryErr error
	calls                          []string
}

func (f *syncReceiptFixture) ListGithubMainPulls(ctx context.Context) ([]db.GithubMainPull, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	return f.rows, f.listErr
}
func (f *syncReceiptFixture) RequestUntrackedGithubMainPulls(ctx context.Context, limit int32) (int64, error) {
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	f.calls = append(f.calls, "discover")
	return 1, f.discoverErr
}
func (f *syncReceiptFixture) RequestAllGithubMainPulls(ctx context.Context) (int64, error) {
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	f.calls = append(f.calls, "retry")
	return 1, f.retryErr
}

func TestSyncRowReadsPersistedReceipts(t *testing.T) {
	now := time.Now().UTC()
	f := &syncReceiptFixture{rows: []db.GithubMainPull{{LastSyncedAt: pgtype.Timestamptz{Time: now, Valid: true}}, {}, {LastSyncedAt: pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true}}}}
	s := gitHubMainPullStreams{receipts: f}
	got, err := s.RequiredStreams(t.Context())
	require.NoError(t, err)
	require.Len(t, got, 3)
	require.Equal(t, now, *got[0].LastSuccessAt)
	require.Nil(t, got[1].LastSuccessAt)
	require.Equal(t, now.Add(-time.Minute), *got[2].LastSuccessAt)
	// Missing receipts cannot claim that every required stream succeeded.
	require.Nil(t, aggregateGitHubSyncHealth(got, now).LastSuccessAt)
	f.rows[0].LastSyncedAt.Time = now.Add(time.Hour)
	require.Equal(t, now, *got[0].LastSuccessAt, "projection does not alias store rows")
	f.listErr = errors.New("database unavailable")
	_, err = s.RequiredStreams(t.Context())
	require.ErrorIs(t, err, f.listErr)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = s.RequiredStreams(ctx)
	require.ErrorIs(t, err, context.Canceled)
	require.ErrorIs(t, s.RetryStreams(ctx), context.Canceled)
	require.Empty(t, f.calls)
}

func TestSyncRowRetryEnrolsBeforeSchedulingAndCanBeRepeated(t *testing.T) {
	f := &syncReceiptFixture{}
	s := gitHubMainPullStreams{receipts: f}
	for range 2 {
		require.NoError(t, s.RetryStreams(t.Context()))
	}
	require.Equal(t, []string{"discover", "retry", "discover", "retry"}, f.calls)
	f.calls = nil
	f.discoverErr = errors.New("enrolment failed")
	require.ErrorIs(t, s.RetryStreams(t.Context()), f.discoverErr)
	require.Equal(t, []string{"discover"}, f.calls)
	f.calls = nil
	f.discoverErr = nil
	f.retryErr = errors.New("scheduling failed")
	require.ErrorIs(t, s.RetryStreams(t.Context()), f.retryErr)
	require.Equal(t, []string{"discover", "retry"}, f.calls)
	f.retryErr = nil
	require.NoError(t, s.RetryStreams(t.Context()))
}

// Permuting or duplicating required receipts must not change their aggregate.
func FuzzSyncRowReceiptOrder(f *testing.F) {
	f.Add([]byte{0, 1, 2, 3, 4, 5})
	f.Add([]byte{})
	f.Add([]byte{255, 0, 4})
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 256 {
			raw = raw[:256]
		}
		now := time.Unix(1700000000, 0).UTC()
		streams := make([]GitHubSyncStream, 0, len(raw))
		for _, v := range raw {
			at := now.Add(-time.Duration(v) * time.Second)
			retry := now.Add(time.Duration(int(v)-120) * time.Second)
			s := GitHubSyncStream{LastSuccessAt: &at, RetryAt: &retry}
			if v%5 == 0 {
				s.LastSuccessAt = nil
			}
			if v%7 == 0 {
				s.Cause = "permission"
			}
			if v%11 == 0 {
				s.Cause = "not_installed"
			}
			streams = append(streams, s)
		}
		want := aggregateGitHubSyncHealth(streams, now)
		for i, j := 0, len(streams)-1; i < j; i, j = i+1, j-1 {
			streams[i], streams[j] = streams[j], streams[i]
		}
		if got := aggregateGitHubSyncHealth(streams, now); !reflect.DeepEqual(want, got) {
			t.Fatalf("order changed aggregate: %+v != %+v", want, got)
		}
		if got := aggregateGitHubSyncHealth(append(streams, streams...), now); !reflect.DeepEqual(want, got) {
			t.Fatalf("duplicates changed aggregate: %+v != %+v", want, got)
		}
	})
}
