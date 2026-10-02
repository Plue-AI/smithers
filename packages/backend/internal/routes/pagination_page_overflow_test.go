package routes

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

type pageShareListingService struct {
	fakeShareListingRouteService
	called bool
	query  services.ShareListingQuery
}

func (s *pageShareListingService) List(_ context.Context, query services.ShareListingQuery) (services.ShareListingPage, error) {
	s.called, s.query = true, query
	return services.ShareListingPage{Page: query.Page, PerPage: query.PerPage}, nil
}

func (s *pageShareListingService) ListForOwner(_ context.Context, _ int64, query services.ShareListingQuery) (services.ShareListingPage, error) {
	return s.List(context.Background(), query)
}

func TestShareListingRoutesRejectUnrepresentablePageOffsets(t *testing.T) {
	if strconv.IntSize < 64 {
		t.Skip("int64 page range requires a 64-bit host")
	}
	const perPage = 4
	maxPage := int64(math.MaxInt64/int64(perPage) + 1)
	for _, path := range []string{"/api/share/listings", "/api/share/my/listings"} {
		for _, tc := range []struct {
			page int64
			want int
		}{
			{maxPage, http.StatusOK},
			{maxPage + 1, http.StatusBadRequest},
		} {
			svc := &pageShareListingService{}
			req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("%s?page=%d&perPage=%d", path, tc.page, perPage), nil)
			rec := serveShareListingRoute(NewShareListingHandler(svc), req, 42, true)
			require.Equal(t, tc.want, rec.Code, "%s page=%d: %s", path, tc.page, rec.Body.String())
			if tc.want == http.StatusBadRequest {
				require.Contains(t, rec.Body.String(), `"code":"bad_request"`)
			} else {
				require.Contains(t, rec.Body.String(), `"hasMore":false`)
			}
			require.Equal(t, tc.want == http.StatusOK, svc.called)
			if svc.called {
				require.Equal(t, int(tc.page), svc.query.Page)
				require.Equal(t, perPage, svc.query.PerPage)
			}
		}
	}
}

func TestPageRoutesRejectPageBeyondIntRange(t *testing.T) {
	for _, path := range []string{"/api/share/listings", "/api/share/my/listings"} {
		svc := &pageShareListingService{}
		req := httptest.NewRequest(http.MethodGet, path+"?page=9223372036854775808", nil)
		rec := serveShareListingRoute(NewShareListingHandler(svc), req, 42, true)
		require.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
		require.Contains(t, rec.Body.String(), `"code":"bad_request"`)
		require.False(t, svc.called)
	}
}
