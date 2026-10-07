package machined

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/hostexec"
	"github.com/smithersai/smithers/packages/backend/internal/machined/wire"
	"github.com/stretchr/testify/require"
)

func TestHostHeadUsesRecordedSeedAndHeldRef(t *testing.T) {
	repo, bundle, base, head := bundleFixture(t)
	branch := "11111111-1111-4111-8111-111111111111"
	visits := 0
	objects := HostObjects{Visit: func(_ context.Context, id string, visit func(string) error) error {
		if id != branch {
			return ErrUnauthorized
		}
		visits++
		return visit(repo)
	}}
	got, err := objects.Head(t.Context(), branch, "")
	require.ErrorIs(t, err, ErrNotReady)
	require.Empty(t, got)
	got, err = objects.Head(t.Context(), branch, "--all")
	require.ErrorIs(t, err, ErrNotReady)
	require.Empty(t, got)
	got, err = objects.Head(t.Context(), branch, base)
	require.NoError(t, err)
	require.Equal(t, base, got)
	got, err = objects.Head(t.Context(), branch, strings.Repeat("f", 40))
	require.NoError(t, err)
	require.Equal(t, base, got, "a recorded seed cannot replace an existing head")
	file, err := os.Open(bundle)
	require.NoError(t, err)
	defer file.Close()
	require.NoError(t, objects.Import(t.Context(), branch, file))
	tree, err := objects.Tree(t.Context(), branch, head)
	require.NoError(t, err)
	out, err := hostexec.Git(t.Context(), "-C", repo, "rev-parse", head+"^{tree}").Output()
	require.NoError(t, err)
	require.Equal(t, strings.TrimSpace(string(out)), tree)
	_, err = objects.Tree(t.Context(), branch, "--all")
	require.ErrorIs(t, err, wire.BadValue)
	_, err = objects.Head(t.Context(), "foreign", base)
	require.ErrorIs(t, err, ErrUnauthorized)
	require.Equal(t, 6, visits)
}
