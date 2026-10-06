package diffview

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

type fakeChangeDiffClient struct {
	files map[string]string
}

func (f fakeChangeDiffClient) GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
	return repohost.Change{}, nil
}

func (f fakeChangeDiffClient) GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, nil
}

func (f fakeChangeDiffClient) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	return repohost.FileContent{Content: f.files[changeID+":"+path]}, nil
}

func newDiffBudget() *int {
	budget := maxTotalDiffContentBytes
	return &budget
}

func TestBuildUnifiedPatch_CountsAdditionsAndDeletions(t *testing.T) {
	t.Parallel()

	patch, additions, deletions, err := buildUnifiedPatch(
		repohost.FileDiff{
			Path:       "src/main.go",
			ChangeType: "modified",
		},
		"package main\n\nfunc main() {\n\tprintln(\"old\")\n}\n",
		"package main\n\nfunc main() {\n\tprintln(\"new\")\n\tprintln(\"extra\")\n}\n",
	)
	require.NoError(t, err)

	assert.Equal(t, 2, additions)
	assert.Equal(t, 1, deletions)
	assert.Contains(t, patch, "--- a/src/main.go")
	assert.Contains(t, patch, "+++ b/src/main.go")
	assert.Contains(t, patch, `+	println("extra")`)
}

func TestBuildUnifiedPatch_CountsContentLinesThatLookLikeHeaders(t *testing.T) {
	t.Parallel()

	_, additions, deletions, err := buildUnifiedPatch(
		repohost.FileDiff{
			Path:       "README.md",
			ChangeType: "modified",
		},
		"stable\n-- old marker\n",
		"stable\n++ new marker\n",
	)
	require.NoError(t, err)

	assert.Equal(t, 1, additions)
	assert.Equal(t, 1, deletions)
}

func TestBuildFileDiff_IgnoresWhitespaceOnlyChanges(t *testing.T) {
	t.Parallel()

	client := fakeChangeDiffClient{
		files: map[string]string{
			"parent:README.md": "hello world\n",
			"change:README.md": "hello   world\n",
		},
	}

	_, include, err := buildFileDiff(
		context.Background(),
		client,
		"alice",
		"demo",
		"parent",
		"change",
		repohost.FileDiff{
			Path:       "README.md",
			ChangeType: "modified",
		},
		BuildOptions{IgnoreWhitespace: true},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.False(t, include)
}

func TestBuildFileDiff_DegradesOversizedFiles(t *testing.T) {
	t.Parallel()

	big := strings.Repeat("x", maxFileDiffContentBytes)
	client := fakeChangeDiffClient{
		files: map[string]string{
			"parent:big.txt": big + "old\n",
			"change:big.txt": big + "new\n",
		},
	}

	got, include, err := buildFileDiff(
		context.Background(),
		client,
		"alice",
		"demo",
		"parent",
		"change",
		repohost.FileDiff{Path: "big.txt", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.True(t, got.TooLarge)
	assert.False(t, got.IsBinary)
	assert.Empty(t, got.Patch)
	assert.Empty(t, got.OldContent)
	assert.Empty(t, got.NewContent)
	assert.Zero(t, got.Additions)
	assert.Zero(t, got.Deletions)
}

func TestBuildFileDiff_DegradesFilesOverLineCap(t *testing.T) {
	t.Parallel()

	manyLines := strings.Repeat("a\n", maxFileDiffLines+1)
	client := fakeChangeDiffClient{
		files: map[string]string{
			"parent:lines.txt": manyLines,
			"change:lines.txt": manyLines + "b\n",
		},
	}

	got, include, err := buildFileDiff(
		context.Background(),
		client,
		"alice",
		"demo",
		"parent",
		"change",
		repohost.FileDiff{Path: "lines.txt", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.True(t, got.TooLarge)
	assert.Empty(t, got.Patch)
}

func TestBuildFileDiff_ExhaustedBudgetSkipsFetching(t *testing.T) {
	t.Parallel()

	client := fakeChangeDiffClient{
		files: map[string]string{
			"parent:small.txt": "old\n",
			"change:small.txt": "new\n",
		},
	}

	budget := 0
	got, include, err := buildFileDiff(
		context.Background(),
		client,
		"alice",
		"demo",
		"parent",
		"change",
		repohost.FileDiff{Path: "small.txt", ChangeType: "modified"},
		BuildOptions{},
		&budget,
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.True(t, got.TooLarge)
	assert.Empty(t, got.Patch)
	assert.Empty(t, got.OldContent)
	assert.Empty(t, got.NewContent)
}

func TestBuildFileDiff_TreatsBase64ContentAsBinary(t *testing.T) {
	t.Parallel()

	client := base64ChangeDiffClient{}

	got, include, err := buildFileDiff(
		context.Background(),
		client,
		"alice",
		"demo",
		"parent",
		"change",
		repohost.FileDiff{Path: "blob.bin", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.True(t, got.IsBinary)
	assert.False(t, got.TooLarge)
	assert.Empty(t, got.Patch)
	assert.Empty(t, got.OldContent)
	assert.Empty(t, got.NewContent)
}

func TestBuildFileDiff_PropagatesRepoHostTooLarge(t *testing.T) {
	t.Parallel()

	client := tooLargeChangeDiffClient{}

	got, include, err := buildFileDiff(
		context.Background(),
		client,
		"alice",
		"demo",
		"parent",
		"change",
		repohost.FileDiff{Path: "huge.txt", ChangeType: "modified"},
		BuildOptions{},
		newDiffBudget(),
	)
	require.NoError(t, err)
	assert.True(t, include)
	assert.True(t, got.TooLarge)
	assert.Empty(t, got.Patch)
}

type base64ChangeDiffClient struct{}

func (base64ChangeDiffClient) GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
	return repohost.Change{}, nil
}

func (base64ChangeDiffClient) GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, nil
}

func (base64ChangeDiffClient) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	return repohost.FileContent{Path: path, Content: "iVBORw0KGgo=", Encoding: "base64"}, nil
}

type tooLargeChangeDiffClient struct{}

func (tooLargeChangeDiffClient) GetChange(ctx context.Context, owner, repo, changeID string) (repohost.Change, error) {
	return repohost.Change{}, nil
}

func (tooLargeChangeDiffClient) GetChangeDiff(ctx context.Context, owner, repo, changeID string) (repohost.ChangeDiff, error) {
	return repohost.ChangeDiff{}, nil
}

func (tooLargeChangeDiffClient) GetFileAtChange(ctx context.Context, owner, repo, changeID, path string) (repohost.FileContent, error) {
	return repohost.FileContent{Path: path, TooLarge: true}, nil
}

func TestDetectLanguage(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "typescript", detectLanguage("src/app.ts", ""))
	assert.Equal(t, "tsx", detectLanguage("src/App.tsx", ""))
	assert.Equal(t, "markdown", detectLanguage("README.md", ""))
	assert.Equal(t, "dockerfile", detectLanguage("Dockerfile", ""))
	assert.Equal(t, "", detectLanguage("unknown.custom", ""))
	assert.Equal(t, "go", detectLanguage("README.md", "go"))
}

func TestLooksBinary(t *testing.T) {
	t.Parallel()

	assert.False(t, looksBinary("README.md", "plain text\n"))
	assert.True(t, looksBinary("blob.bin", "abc\x00def"))
	assert.True(t, looksBinary("image.png"))
}

func TestCapturedBlobDiffHasNoSyntheticBlankLines(t *testing.T) {
	for _, tc := range []struct{ name, kind, before, after, expected string }{
		{"added", "added", "", "export const backoff = 100;\n", "--- /dev/null\n+++ b/src/backoff.ts\n@@ -0,0 +1 @@\n+export const backoff = 100;\n"},
		{"modified", "modified", "export const backoff = 2;\n", "export const backoff = 100;\n", "--- a/src/backoff.ts\n+++ b/src/backoff.ts\n@@ -1 +1 @@\n-export const backoff = 2;\n+export const backoff = 100;\n"},
		{"deleted", "deleted", "export const backoff = 100;\n", "", "--- a/src/backoff.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const backoff = 100;\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file := repohost.FileDiff{Path: "src/backoff.ts", ChangeType: tc.kind}
			patch, _, _, err := buildUnifiedPatch(file, tc.before, tc.after)
			require.NoError(t, err)
			require.Equal(t, tc.expected, patch)
			patch, _, _ = buildIgnoreWhitespacePatch(file, tc.before, tc.after)
			require.Equal(t, tc.expected, patch)
		})
	}
}
