package services

import (
	"encoding/json"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestTODOBranchDiffItemOnlyProjection(t *testing.T) {
	files := []repohost.FileDiff{
		{Path: "new.txt", ChangeType: "added", Patch: "@@ -0,0 +1,2 @@\n+first\n+\n\\ No newline at end of file\n"},
		{Path: "edit.txt", ChangeType: "modified", Patch: "@@ -2,2 +2,2 @@ section\n context\n-old\n+new\n@@ -8 +8 @@\n-before\n+after\n"},
		{Path: "gone.txt", ChangeType: "deleted", Patch: "@@ -1 +0,0 @@\n-gone\n"},
		{Path: "after.txt", OldPath: "before.txt", ChangeType: "renamed"},
		{Path: "asset.bin", ChangeType: "modified", IsBinary: true, Patch: "must not parse", OldContent: "not blob bytes"},
	}
	result, err := ProjectTODOBranchDiff("branch-id", "accepted-prefix", files, map[string]BranchDiffBinary{"asset.bin": {BeforeBytes: 7, AfterBytes: 11}})
	require.NoError(t, err)
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	require.JSONEq(t, `{"files":[
 {"path":"new.txt","branch":"branch-id","against":{"kind":"item_base","rev":"accepted-prefix"},"change":"added","hunks":[{"old_start":0,"new_start":1,"lines":[{"op":"+","text":"first"},{"op":"+","text":""}]}]},
 {"path":"edit.txt","branch":"branch-id","against":{"kind":"item_base","rev":"accepted-prefix"},"change":"modified","hunks":[{"old_start":2,"new_start":2,"lines":[{"op":" ","text":"context"},{"op":"-","text":"old"},{"op":"+","text":"new"}]},{"old_start":8,"new_start":8,"lines":[{"op":"-","text":"before"},{"op":"+","text":"after"}]}]},
 {"path":"gone.txt","branch":"branch-id","against":{"kind":"item_base","rev":"accepted-prefix"},"change":"deleted","hunks":[{"old_start":1,"new_start":0,"lines":[{"op":"-","text":"gone"}]}]},
 {"path":"before.txt","branch":"branch-id","against":{"kind":"item_base","rev":"accepted-prefix"},"change":"renamed","renamed_to":"after.txt","hunks":[]},
 {"path":"asset.bin","branch":"branch-id","against":{"kind":"item_base","rev":"accepted-prefix"},"change":"modified","binary":{"before_bytes":7,"after_bytes":11},"hunks":[]}
 ]}`, string(encoded))
	empty, err := ProjectTODOBranchDiff("b", "prefix", nil, nil)
	require.NoError(t, err)
	encoded, err = json.Marshal(empty)
	require.NoError(t, err)
	require.JSONEq(t, `{"files":[]}`, string(encoded))
}
func TestTODOBranchDiffMissingFactsNeverReturnsPartialFiles(t *testing.T) {
	for _, tc := range []struct {
		name, branch, prefix string
		file                 repohost.FileDiff
		sizes                map[string]BranchDiffBinary
	}{
		{name: "branch", prefix: "base"},
		{name: "prefix", branch: "b"},
		{name: "path", branch: "b", prefix: "base"},
		{name: "too large", branch: "b", prefix: "base", file: repohost.FileDiff{Path: "huge", ChangeType: "modified", TooLarge: true}},
		{name: "binary size absent", branch: "b", prefix: "base", file: repohost.FileDiff{Path: "asset", ChangeType: "added", IsBinary: true}},
		{name: "negative binary size", branch: "b", prefix: "base", file: repohost.FileDiff{Path: "asset", ChangeType: "modified", IsBinary: true}, sizes: map[string]BranchDiffBinary{"asset": {BeforeBytes: -1}}},
		{name: "negative after size", branch: "b", prefix: "base", file: repohost.FileDiff{Path: "asset", ChangeType: "modified", IsBinary: true}, sizes: map[string]BranchDiffBinary{"asset": {AfterBytes: -1}}},
		{name: "rename source", branch: "b", prefix: "base", file: repohost.FileDiff{Path: "new", ChangeType: "renamed"}},
		{name: "unknown change", branch: "b", prefix: "base", file: repohost.FileDiff{Path: "x", ChangeType: "copied"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := ProjectTODOBranchDiff(tc.branch, tc.prefix, []repohost.FileDiff{{Path: "valid", ChangeType: "added"}, tc.file}, tc.sizes)
			require.Error(t, err)
			require.Nil(t, result.Files)
		})
	}
}
