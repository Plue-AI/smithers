package httpapi_test

import (
	"net/http/httptest"
	"strconv"
	"testing"

	apierrors "github.com/smithersai/smithers/packages/backend/errors"
	"github.com/smithersai/smithers/packages/backend/httpapi"
	"github.com/stretchr/testify/require"
)

func TestPublicLegacyPaginationRefusesUnrepresentableOffsets(t *testing.T) {
	request := httptest.NewRequest("GET", "/items?page=92233720368547759&per_page=100", nil)
	cursor, limit, err := httpapi.ParsePagination(request)
	require.NoError(t, err)
	require.Equal(t, "9223372036854775800", cursor)
	require.Equal(t, 100, limit)
	for _, query := range []string{
		"page=92233720368547760&per_page=100",   // first unsafe quotient
		"page=9223372036854775807&per_page=100", // wraps negative without admission
		"page=4611686018427387906&per_page=4",   // wraps positive to offset four
	} {
		t.Run(query, func(t *testing.T) {
			cursor, limit, err := httpapi.ParsePagination(httptest.NewRequest("GET", "/items?"+query, nil))
			var problem *apierrors.APIError
			require.ErrorAs(t, err, &problem)
			require.Equal(t, 400, problem.Status)
			require.Equal(t, "page offset is too large", problem.Message)
			require.Equal(t, "bad_request", string(problem.Code))
			require.Equal(t, "user", string(problem.Fault))
			require.Empty(t, cursor)
			require.Zero(t, limit)
		})
	}

}

func TestPublicPaginationLastLinkUsesOverflowSafeCeiling(t *testing.T) {
	request := httptest.NewRequest("GET", "/items?label=a&limit=100", nil)
	recorder := httptest.NewRecorder()
	httpapi.SetPaginationHeaders(recorder, request, "", 100, 100, 9_223_372_036_854_775_807)
	require.Equal(t, "9223372036854775807", recorder.Header().Get("X-Total-Count"))
	require.Equal(t, `</items?label=a&page=1&per_page=100>; rel="first", </items?label=a&page=92233720368547759&per_page=100>; rel="last", </items?label=a&page=2&per_page=100>; rel="next"`, recorder.Header().Get("Link"))
}

func TestPublicPaginationExtremeCursorAndPriority(t *testing.T) {
	for _, tc := range []struct {
		cursor string
		limit  int
		page   int
	}{
		{"9223372036854775805", 1, 9223372036854775806},
		{"9223372036854775806", 1, 9223372036854775807},
		{"9223372036854775807", 1, int(^uint(0) >> 1)},
		{"9223372036854775807", 2, 4611686018427387904},
		{"9223372036854775807", 100, 92233720368547759},
		{"60", 0, 3}, {"60", -1, 3},
	} {
		t.Run(tc.cursor+"/"+strconv.Itoa(tc.limit), func(t *testing.T) {
			require.Equal(t, tc.page, httpapi.CursorToPage(tc.cursor, tc.limit))
		})
	}
	for _, tc := range []struct {
		query, cursor string
		limit         int
	}{
		{"page=9223372036854775807&per_page=1", "9223372036854775806", 1},
		{"page=3074457345618258603&per_page=3", "9223372036854775806", 3},
		{"cursor=7&page=9223372036854775807&per_page=100", "7", 100},
		{"cursor=7&page=not-a-page&limit=1", "7", 1},
		{"cursor=7&page=9223372036854775807", "7", 30},
	} {
		t.Run(tc.query, func(t *testing.T) {
			cursor, limit, err := httpapi.ParsePagination(httptest.NewRequest("GET", "/items?"+tc.query, nil))
			require.NoError(t, err)
			require.Equal(t, tc.cursor, cursor)
			require.Equal(t, tc.limit, limit)
		})
	}
}

func TestPublicPaginationLastLinkExactCeilingNeighbors(t *testing.T) {
	for _, tc := range []struct {
		total int64
		last  string
	}{
		{9223372036854775800, "92233720368547758"},
		{9223372036854775801, "92233720368547759"},
		{9223372036854775807, "92233720368547759"},
	} {
		t.Run(strconv.FormatInt(tc.total, 10), func(t *testing.T) {
			recorder := httptest.NewRecorder()
			httpapi.SetPaginationHeaders(recorder, httptest.NewRequest("GET", "/items", nil), "", 100, 100, tc.total)
			require.Equal(t, `</items?page=1&per_page=100>; rel="first", </items?page=`+tc.last+`&per_page=100>; rel="last", </items?page=2&per_page=100>; rel="next"`, recorder.Header().Get("Link"))
			require.Equal(t, strconv.FormatInt(tc.total, 10), recorder.Header().Get("X-Total-Count"))
		})
	}
}
