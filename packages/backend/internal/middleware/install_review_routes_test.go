package middleware

import (
	"github.com/stretchr/testify/require"
	"net/http"
	"testing"
)

func TestInstallReviewReadBoundaryRoutes(t *testing.T) {
	for _, tc := range []struct{ method, path, command string }{
		{http.MethodPost, "/api/reviews", "review"},
		{http.MethodGet, "/api/reviews/11111111-1111-4111-8111-111111111111", "repo.read"},
		{http.MethodGet, "/api/reviews", ""},
		{http.MethodPost, "/api/reviews/11111111-1111-4111-8111-111111111111", ""},
		{http.MethodGet, "/api/reviews/x/more", ""},
	} {
		require.Equal(t, tc.command, InstallMemberCommand(tc.method, tc.path), tc.method+" "+tc.path)
	}
}
