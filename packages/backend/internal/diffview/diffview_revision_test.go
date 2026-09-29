package diffview

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type revisionDiffFixture struct {
	oldContent string
	newContent string
}

func (f revisionDiffFixture) GetRevisionDiff(_ context.Context, _, _, _, _, _, _ string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{FileDiffs: []repohost.FileDiff{{
		Path: "main.go", ChangeType: "modified",
		OldContent: f.oldContent, NewContent: f.newContent,
	}}}, nil
}

func TestRevisionDiffIgnoreWhitespaceMixedEdits(t *testing.T) {
	t.Parallel()
	client := revisionDiffFixture{
		oldContent: "func a() {\n    x := 1\n    y := 2\n    z := 3\n}\n",
		newContent: "func a() {\n\tx := 1\n\ty := 20\n\tz := 3\n}\n",
	}
	ordinary, err := BuildRevisionDiff(context.Background(), client, "alice", "demo", "change", "from", "to", "", BuildOptions{})
	require.NoError(t, err)
	require.Len(t, ordinary.FileDiffs, 1)
	assert.Equal(t, 3, ordinary.FileDiffs[0].Additions)
	assert.Equal(t, 3, ordinary.FileDiffs[0].Deletions)

	ignored, err := BuildRevisionDiff(context.Background(), client, "alice", "demo", "change", "from", "to", "", BuildOptions{IgnoreWhitespace: true})
	require.NoError(t, err)
	require.Len(t, ignored.FileDiffs, 1)
	assert.Equal(t, 1, ignored.FileDiffs[0].Additions)
	assert.Equal(t, 1, ignored.FileDiffs[0].Deletions)
	assert.Contains(t, ignored.FileDiffs[0].Patch, "-    y := 2\n")
	assert.Contains(t, ignored.FileDiffs[0].Patch, "+\ty := 20\n")
	assert.NotContains(t, ignored.FileDiffs[0].Patch, "-    x := 1")
	assert.NotContains(t, ignored.FileDiffs[0].Patch, "-    z := 3")
}

func TestRevisionDiffIgnoreWhitespaceOnly(t *testing.T) {
	t.Parallel()
	client := revisionDiffFixture{oldContent: "    x := 1\n", newContent: "\tx := 1\n"}
	diff, err := BuildRevisionDiff(context.Background(), client, "alice", "demo", "change", "from", "to", "", BuildOptions{IgnoreWhitespace: true})
	require.NoError(t, err)
	assert.Empty(t, diff.FileDiffs)
}
