package services

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

type pushAncestryResolver struct {
	WorkflowBookmarkCommitResolver
	ancestor bool
	err      error
	calls    int
}

func (r *pushAncestryResolver) IsAncestor(_ context.Context, repoID int64, head, commit string) (bool, error) {
	r.calls++
	return r.ancestor, r.err
}

func TestWorkflowPushHeadFreshness(t *testing.T) {
	for _, tc := range []struct {
		name, head, commit string
		ancestor           bool
		err                error
		want               bool
		calls              int
	}{
		{name: "equal", head: " head ", commit: "head", want: true},
		{name: "resolver lags", head: "old", commit: "new", ancestor: true, want: true, calls: 1},
		{name: "late or divergent", head: "new", commit: "old", calls: 1},
		{name: "ancestry unavailable", head: "old", commit: "new", err: errors.New("offline"), calls: 1},
		{name: "deleted ref", head: "head"},
		{name: "empty resolver", commit: "head"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &pushAncestryResolver{ancestor: tc.ancestor, err: tc.err}
			got, err := workflowPushHeadIsFresh(t.Context(), r, 42, tc.head, tc.commit)
			require.Equal(t, tc.want, got)
			require.ErrorIs(t, err, tc.err)
			require.Equal(t, tc.calls, r.calls)
		})
	}
}
