package machined

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestGitBurstObjectsVerification(t *testing.T) {
	ctx := context.Background()
	s, b := fixtureVersions(t)
	missing, err := s.Verify(ctx, "", b)
	require.NoError(t, err)
	require.Empty(t, missing)
	renamed := b
	renamed.Files = append([]wire.BurstFile(nil), b.Files...)
	renamed.Files[0].Change = "renamed"
	renamed.Files[0].RenamedTo = "renamed.ts"
	missing, err = s.Verify(ctx, "", renamed)
	require.NoError(t, err)
	require.Empty(t, missing)
	// The destination is metadata. The original path names both tree sides.
	require.NoError(t, validateBurst(renamed))
	extra := b
	extra.Files = append([]wire.BurstFile(nil), b.Files...)
	extra.Files[0].Path = "other.ts"
	_, err = s.Verify(ctx, "", extra)
	require.ErrorIs(t, err, wire.BadValue)
	badType := b
	badType.VersionsCommit = b.Files[0].BeforeBlob
	_, err = s.Verify(ctx, "", badType)
	require.ErrorIs(t, err, wire.BadValue)
	absent := b
	absent.VersionsCommit = strings.Repeat("a", 40)
	missing, err = s.Verify(ctx, "", absent)
	require.NoError(t, err)
	require.Equal(t, []string{strings.Repeat("a", 40)}, missing)
	branch := uuid.NewString()
	require.NoError(t, s.Retain(ctx, branch, b))
	require.NoError(t, s.Retain(ctx, branch, b))
	collision := b
	collision.VersionsCommit = b.Files[0].BeforeBlob
	require.Error(t, s.Retain(ctx, branch, collision))
	require.Error(t, s.Retain(ctx, "../unsafe", b))
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = s.Verify(canceled, "", b)
	require.ErrorIs(t, err, context.Canceled)
	_, err = (GitBurstObjects{}).Verify(ctx, "", b)
	require.ErrorIs(t, err, ErrNotReady)
}
