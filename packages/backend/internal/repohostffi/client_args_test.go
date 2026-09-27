//go:build cgo

package repohostffi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// clientCovAssertArgumentOrder drives every method whose fake echoes its
// arguments, so a swapped C argument (from/to commit, prefix/after) fails.
func clientCovAssertArgumentOrder(t *testing.T, client *Client) {
	t.Helper()

	sha, err := client.ProjectWikiRevision("store-ok", `{"page":"Home"}`)
	require.NoError(t, err)
	assert.Equal(t, `store-ok|{"page":"Home"}`, sha)

	doc, err := client.WikiDocument(`{"doc":"x"}`)
	require.NoError(t, err)
	assert.Equal(t, repohost.WikiDocumentResult{State: `{"doc":"x"}`, StateVector: "sv", Markdown: "md"}, doc)

	backout, err := client.BackoutChange("store-ok", "chg", "rev", "main", "")
	require.NoError(t, err)
	assert.Equal(t, "chg", backout.ChangeID)
	assert.Equal(t, "rev", backout.CommitID)
	assert.Equal(t, "main|store-ok", backout.Description)

	split, err := client.SplitChange("store-ok", "chg", []string{"a.go", "b.go"}, "split off")
	require.NoError(t, err)
	assert.Equal(t, "chg", split.Original.ChangeID)
	assert.Equal(t, `["a.go","b.go"]`, split.Original.Description)
	assert.Equal(t, "store-ok", split.Split.ChangeID)
	assert.Equal(t, "split off", split.Split.Description)

	diff, err := client.GetRevisionDiff("store-ok", "from-sha", "to-sha", "docs/a.md")
	require.NoError(t, err)
	assert.Equal(t, "from-sha..to-sha", diff.ChangeID)
	require.Len(t, diff.FileDiffs, 1)
	assert.Equal(t, "docs/a.md", diff.FileDiffs[0].Path)
	assert.Equal(t, "store-ok", diff.FileDiffs[0].OldPath)

	entries, err := client.ListDirectory("store-ok", "chg", "docs/", "docs/b", 7)
	require.NoError(t, err)
	assert.Equal(t, []repohost.TreeEntry{{Path: "chg|docs/|docs/b", Kind: "7"}}, entries)

	source := repohost.WorkspaceSource{ChangeID: "c", CommitID: "k", TreeID: "t", ParentCommitIDs: []string{"p"}}
	receipt, err := client.ReadWorkspaceSource("store-ok", "ws-1", source)
	require.NoError(t, err)
	assert.Equal(t, "store-ok", receipt.Status)
	var sourceRequest repohost.WorkspaceSourceRequest
	require.NoError(t, json.Unmarshal([]byte(receipt.WorkspaceID), &sourceRequest))
	assert.Equal(t, repohost.WorkspaceSourceRequest{WorkspaceID: "ws-1", Source: source}, sourceRequest)

	prepareRequest := repohost.AppendPreparationRequest{TargetBookmark: "main", ExpectedCommitID: "e", SourceCommitID: "s", SourceBaseCommitID: "b"}
	prepared, err := client.PrepareLandAppend("store-ok", prepareRequest)
	require.NoError(t, err)
	assert.Equal(t, "store-ok", prepared.Status)
	var echoedPrepare repohost.AppendPreparationRequest
	require.NoError(t, json.Unmarshal([]byte(prepared.TargetBookmark), &echoedPrepare))
	assert.Equal(t, prepareRequest, echoedPrepare)

	landRequest := `{"change_ids":["a"],"target_bookmark":"main"}`
	landed, err := client.LandChanges("store-ok", landRequest)
	require.NoError(t, err)
	assert.Equal(t, repohost.LandResult{LandedCount: 2, TargetBookmark: landRequest, TargetCommitID: "changes:store-ok"}, landed)

	appendRequest := `{"append":{"source_commit_id":"tip","source_base_commit_id":"base","description":"delivery"}}`
	appended, err := client.LandChanges("store-ok", appendRequest)
	require.NoError(t, err)
	assert.Equal(t, repohost.LandResult{LandedCount: 1, TargetBookmark: appendRequest, TargetCommitID: "append:store-ok"}, appended)

	_, err = client.LandChanges("store-ok", "not-json")
	require.Error(t, err)

	composed, err := client.ComposeSuperproject("store-ok", `{"members":[]}`)
	require.NoError(t, err)
	assert.Equal(t, "store-ok", composed.ChangeID)
	assert.Equal(t, `{"members":[]}`, composed.Description)

	read, err := client.ReadSuperproject("store-ok", "rev-1")
	require.NoError(t, err)
	assert.Equal(t, "store-ok", read.ChangeID)
	assert.Equal(t, "rev-1", read.CommitID)

	// Error envelopes decode the same way on every method.
	var ffiErr *Error
	_, err = client.GetRevisionDiff("ffi-error", "a", "b", "")
	require.ErrorAs(t, err, &ffiErr)
	assert.Equal(t, "not_found", ffiErr.Code)
	_, err = client.ListDirectory("ffi-error", "c", "", "", 1)
	require.ErrorAs(t, err, &ffiErr)
	_, err = client.ReadSuperproject("ffi-error", "r")
	require.ErrorAs(t, err, &ffiErr)
	_, err = client.LandChanges("ffi-error", appendRequest)
	require.ErrorAs(t, err, &ffiErr)

	// NUL bytes are rejected before any C call.
	for _, call := range []func() error{
		func() error { _, err := client.ProjectWikiRevision("s\x00", "{}"); return err },
		func() error { _, err := client.WikiDocument("\x00"); return err },
		func() error { _, err := client.BackoutChange("s", "c\x00", "r", "m", ""); return err },
		func() error { _, err := client.SplitChange("s", "c", []string{"a"}, "d\x00"); return err },
		func() error { _, err := client.GetRevisionDiff("s", "a", "b\x00", ""); return err },
		func() error { _, err := client.ListDirectory("s", "c", "p\x00", "", 1); return err },
		func() error { _, err := client.ReadWorkspaceSource("s\x00", "w", source); return err },
		func() error { _, err := client.PrepareLandAppend("s\x00", prepareRequest); return err },
		func() error { _, err := client.LandChanges("s", "{\x00}"); return err },
		func() error { _, err := client.ComposeSuperproject("s", "\x00"); return err },
		func() error { _, err := client.ReadSuperproject("s", "r\x00"); return err },
	} {
		err := call()
		require.ErrorAs(t, err, &ffiErr)
		assert.Equal(t, "invalid_argument", ffiErr.Code)
	}
}

// TestRequiredSymbolsMatchRustExports pins the Go symbol table to the
// symbols crates/smithers-ffi exports, so Load never rejects the real library
// and never skips a symbol the client calls.
func TestRequiredSymbolsMatchRustExports(t *testing.T) {
	goSource, err := os.ReadFile("client.go")
	require.NoError(t, err)
	table := regexp.MustCompile(`(?s)smithers_symbol_names\[SYM_COUNT\] = \{(.*?)\};`).FindSubmatch(goSource)
	require.NotNil(t, table)
	goSymbols := regexp.MustCompile(`"(smithers_[a-z_]+)"`).FindAllSubmatch(table[1], -1)

	rustFiles, err := filepath.Glob(filepath.Join("..", "..", "..", "..", "crates", "smithers-ffi", "src", "*.rs"))
	require.NoError(t, err)
	require.NotEmpty(t, rustFiles)
	exported := map[string]bool{}
	for _, file := range rustFiles {
		raw, err := os.ReadFile(file)
		require.NoError(t, err)
		for _, match := range regexp.MustCompile(`extern "C" fn (smithers_[a-z_]+)`).FindAllSubmatch(raw, -1) {
			exported[string(match[1])] = true
		}
	}

	required := []string{}
	for _, match := range goSymbols {
		required = append(required, string(match[1]))
	}
	exportedNames := []string{}
	for name := range exported {
		exportedNames = append(exportedNames, name)
	}
	sort.Strings(required)
	sort.Strings(exportedNames)
	assert.Equal(t, strings.Join(exportedNames, "\n"), strings.Join(required, "\n"))
}
