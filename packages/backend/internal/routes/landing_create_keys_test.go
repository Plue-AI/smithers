package routes

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/stretchr/testify/require"
)

func TestLandingCreateKeysReachService(t *testing.T) {
	const key = "github:review:42"
	service := &mockLandingRouteService{
		createReviewFn: func(_ context.Context, _ *db.User, _, _ string, _ int64, input services.CreateLandingReviewInput) (db.LandingRequestReview, error) {
			require.Equal(t, key, input.IdempotencyKey)
			return db.LandingRequestReview{ID: 8}, nil
		},
		createCommentFn: func(_ context.Context, _ *db.User, _, _ string, _ int64, input services.CreateLandingCommentInput) (db.LandingRequestComment, error) {
			require.Equal(t, key, input.IdempotencyKey)
			return db.LandingRequestComment{ID: 9}, nil
		},
	}
	for _, tc := range []struct {
		path, body string
		call       func(*LandingHandler, http.ResponseWriter, *http.Request)
	}{
		{"reviews", `{"type":"comment","body":"hello","commit_id":"head","idempotency_key":"github:review:42"}`, (*LandingHandler).PostLandingReview},
		{"comments", `{"body":"hello","commit_id":"head","idempotency_key":"github:review:42"}`, (*LandingHandler).PostLandingComment},
	} {
		t.Run(tc.path, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/repos/alice/demo/landings/7/"+tc.path, strings.NewReader(tc.body))
			r = withRouteParams(r, map[string]string{"owner": "alice", "repo": "demo", "number": "7"})
			r = withAuth(r, 1, "alice")
			w := httptest.NewRecorder()
			tc.call(&LandingHandler{Service: service}, w, r)
			require.Equal(t, http.StatusCreated, w.Code)
		})
	}
}
