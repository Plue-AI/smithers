package db

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
)

// A committed user from an earlier test can match the full-text token in
// "100%". The literal-wildcard assertions must hold in that suite order.
func TestSearchLikeLiteralIgnoresEarlierCommittedUsers(t *testing.T) {
	ctx := context.Background()
	var seedID int64
	t.Cleanup(func() {
		if seedID == 0 {
			return
		}
		_, err := sharedPool.Exec(ctx, `DELETE FROM users WHERE id = $1`, seedID)
		require.NoError(t, err)
	})
	require.True(t, t.Run("earlier committed user", func(t *testing.T) {
		seedID = mustCreateUser(t, sharedPool, fmt.Sprintf("wildcard-collision-%s-100", randSlug(t)))
		q := New(sharedPool)
		rows, err := q.SearchUsersFTS(ctx, SearchUsersFTSParams{Query: "100%", PageSize: 10000})
		require.NoError(t, err)
		ids := make([]int64, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		require.Contains(t, ids, seedID, "fixture must collide with the literal search query")
	}))

	t.Run("literal wildcards", TestSearchTreatsLikeWildcardsLiterally)

	var stillPresent bool
	require.NoError(t, sharedPool.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)`, seedID).Scan(&stillPresent))
	require.True(t, stillPresent, "isolated search must leave unrelated users intact")
}
