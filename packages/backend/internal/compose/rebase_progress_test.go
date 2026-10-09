package compose

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBranchRebasingProjectionRetainsFacts(t *testing.T) {
	raw := json.RawMessage(`{"id":"b","opaque_counter":9007199254740993,"terminals":[{"id":"shell","frozen":false}],"rebase":{"state":"pending","onto":"main","waiting_for":{"terminal":"private-shell"}}}`)
	projected, err := branchRebasingProjection(raw)
	require.NoError(t, err)
	require.JSONEq(t, `{"id":"b","opaque_counter":9007199254740993,"terminals":[{"id":"shell","frozen":false}],"rebase":{"state":"rebasing","onto":"main"}}`, string(projected))
	require.Contains(t, string(projected), `9007199254740993`)
	for _, retained := range []string{
		`{"id":"b"}`,
		`{"id":"b","rebase":{"state":"conflict","onto":"main","paths":["retry.ts"]}}`,
		`{"id":"b","rebase":{"state":"rebasing","onto":"T2"}}`,
	} {
		projected, err := branchRebasingProjection(json.RawMessage(retained))
		require.NoError(t, err)
		require.Equal(t, retained, string(projected))
	}
	_, err = branchRebasingProjection(json.RawMessage(`invalid`))
	require.Error(t, err)
}
