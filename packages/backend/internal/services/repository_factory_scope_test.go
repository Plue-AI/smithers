package services

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// A repository selector must never be silently ignored: that would execute
// engineering in the declaring repository while the owner expects another.
func TestFactoryRejectsRepositorySelector(t *testing.T) {
	for _, selector := range []string{`"owner/code"`, `""`, `null`, `[]`, `{}`} {
		t.Run(selector, func(t *testing.T) {
			var projection FactoryProjection
			require.NoError(t, json.Unmarshal([]byte(`{"on":[{"event":"issue.labeled:engineering","flow":"engineering","repository":`+selector+`}]}`), &projection))
			// Validation precedes transactions and discovery, even for missing flows.
			service := &RepositoryJobService{}
			err := service.ReconcileFactoryRules(context.Background(), 1, strings.Repeat("a", 40), projection)
			require.ErrorContains(t, err, "declare the flow in the target repository's factory")
		})
	}
}
