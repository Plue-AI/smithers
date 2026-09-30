package routes

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/services"
)

func TestParsePagination_LimitMatrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for limit := -20; limit <= 120; limit++ {
		caseCount++

		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/orgs/acme/repos?cursor=abc&limit=%d", limit), nil)
		cursor, gotLimit, err := parsePagination(req)

		if limit <= 0 {
			requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "invalid limit value")
			assert.Empty(t, cursor)
			assert.Zero(t, gotLimit)
			continue
		}

		require.NoErrorf(t, err, "limit=%d", limit)
		assert.Equalf(t, "abc", cursor, "limit=%d", limit)
		if limit > 100 {
			assert.Equalf(t, 100, gotLimit, "limit=%d", limit)
		} else {
			assert.Equalf(t, limit, gotLimit, "limit=%d", limit)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?cursor=%20abc%20", nil)
	cursor, limit, err := parsePagination(req)
	require.NoError(t, err)
	assert.Equal(t, "abc", cursor)
	assert.Equal(t, 30, limit)

	req = httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos", nil)
	cursor, limit, err = parsePagination(req)
	require.NoError(t, err)
	assert.Empty(t, cursor)
	assert.Equal(t, 30, limit)

	req = httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?limit=abc", nil)
	cursor, limit, err = parsePagination(req)
	requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "invalid limit value")
	assert.Empty(t, cursor)
	assert.Zero(t, limit)

	// Mixed params: the CURSOR wins (clients echo next_cursor while still
	// spelling their page size as per_page — dropping the cursor made them
	// walk page 1 forever), and the explicit `limit` wins over per_page.
	req = httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?cursor=c25&limit=5&page=2&per_page=40", nil)
	cursor, limit, err = parsePagination(req)
	require.NoError(t, err)
	assert.Equal(t, "c25", cursor)
	assert.Equal(t, 5, limit)

	req = httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?page=2&per_page=101", nil)
	cursor, limit, err = parsePagination(req)
	requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "per_page must not exceed 100")
	assert.Empty(t, cursor)
	assert.Zero(t, limit)

	assert.Equal(t, 141, caseCount)
}

func TestParseLegacyPagination_Matrix(t *testing.T) {
	t.Parallel()

	pages := []int{-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	perPages := []int{-2, -1, 0, 1, 2, 29, 30, 31, 50, 99, 100, 101}

	caseCount := 0
	for _, capOversized := range []bool{false, true} {
		for _, page := range pages {
			for _, perPage := range perPages {
				caseCount++

				query := url.Values{}
				query.Set("page", fmt.Sprintf(" %d ", page))
				query.Set("per_page", fmt.Sprintf(" %d ", perPage))

				cursor, limit, err := parseLegacyPagination(query, 30, 100, capOversized)
				switch {
				case page <= 0:
					requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "invalid page value")
					assert.Empty(t, cursor)
					assert.Zero(t, limit)
				case perPage <= 0:
					requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "invalid per_page value")
					assert.Empty(t, cursor)
					assert.Zero(t, limit)
				case perPage > 100 && !capOversized:
					requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "per_page must not exceed 100")
					assert.Empty(t, cursor)
					assert.Zero(t, limit)
				default:
					require.NoErrorf(t, err, "cap=%v page=%d perPage=%d", capOversized, page, perPage)

					wantLimit := perPage
					if wantLimit > 100 {
						wantLimit = 100
					}
					wantCursor := offsetToCursor(int64((page - 1) * wantLimit))

					assert.Equalf(t, wantCursor, cursor, "cap=%v page=%d perPage=%d", capOversized, page, perPage)
					assert.Equalf(t, wantLimit, limit, "cap=%v page=%d perPage=%d", capOversized, page, perPage)
				}
			}
		}
	}

	cursor, limit, err := parseLegacyPagination(url.Values{}, 30, 100, false)
	require.NoError(t, err)
	assert.Empty(t, cursor)
	assert.Equal(t, 30, limit)

	cursor, limit, err = parseLegacyPagination(url.Values{"page": []string{"3"}}, 30, 100, false)
	require.NoError(t, err)
	assert.Equal(t, "60", cursor)
	assert.Equal(t, 30, limit)

	cursor, limit, err = parseLegacyPagination(url.Values{"per_page": []string{"15"}}, 30, 100, false)
	require.NoError(t, err)
	assert.Empty(t, cursor)
	assert.Equal(t, 15, limit)

	assert.Equal(t, 360, caseCount)
}

func TestCursorPaginationHelpers_RoundTripMatrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for offset := -25; offset <= 125; offset++ {
		caseCount++

		cursor := offsetToCursor(int64(offset))
		gotOffset := cursorToOffset(cursor)
		gotPage := cursorToPage(cursor, 15)

		if offset <= 0 {
			assert.Emptyf(t, cursor, "offset=%d", offset)
			assert.Zerof(t, gotOffset, "offset=%d", offset)
			assert.Equalf(t, 1, gotPage, "offset=%d", offset)
			continue
		}

		assert.Equalf(t, fmt.Sprintf("%d", offset), cursor, "offset=%d", offset)
		assert.Equalf(t, int64(offset), gotOffset, "offset=%d", offset)
		assert.Equalf(t, (offset/15)+1, gotPage, "offset=%d", offset)
	}

	for _, tc := range []struct {
		cursor   string
		wantPage int
	}{
		{cursor: "", wantPage: 1},
		{cursor: "-1", wantPage: 1},
		{cursor: "abc", wantPage: 1},
		{cursor: "1.5", wantPage: 1},
		{cursor: " 4 ", wantPage: 1},
		{cursor: "45", wantPage: 2},
	} {
		assert.Equal(t, tc.wantPage, cursorToPage(tc.cursor, 0))
		if tc.wantPage == 1 && tc.cursor != "" {
			assert.Zero(t, cursorToOffset(tc.cursor))
		}
	}

	assert.Equal(t, 151, caseCount)
}

func TestLegacyPageValue_Matrix(t *testing.T) {
	t.Parallel()

	legacyReq := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?page=3&per_page=20", nil)
	page, ok := legacyPageValue(legacyReq, "40", 20)
	require.True(t, ok)
	assert.Equal(t, 3, page)

	cursorReq := httptest.NewRequest(http.MethodGet, "/api/orgs/acme/repos?cursor=40&limit=20", nil)
	page, ok = legacyPageValue(cursorReq, 2, 20)
	require.True(t, ok)
	assert.Equal(t, 2, page)

	page, ok = legacyPageValue(cursorReq, "40", 20)
	assert.False(t, ok)
	assert.Zero(t, page)

	page, ok = legacyPageValue(legacyReq, struct{}{}, 20)
	assert.False(t, ok)
	assert.Zero(t, page)
}

func TestSetCursorPaginationHeaders_Matrix(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/users/alice/repos?state=open&cursor=old&limit=10", nil)
	rec := httptest.NewRecorder()

	setCursorPaginationHeaders(rec, req, 25, "75")

	linkHeader := rec.Header().Get("Link")
	require.NotEmpty(t, linkHeader)
	assert.Contains(t, linkHeader, `rel="first"`)
	assert.Contains(t, linkHeader, `rel="next"`)
	assert.Contains(t, linkHeader, "/api/users/alice/repos?")
	assert.Contains(t, linkHeader, "limit=25")
	assert.Contains(t, linkHeader, "cursor=75")
	assert.Contains(t, linkHeader, "state=open")
	assert.NotContains(t, linkHeader, "cursor=old")
	assert.NotContains(t, linkHeader, "limit=10")
}

func TestSetOffsetCursorPaginationHeaders_UsesPageAlignedLinks(t *testing.T) {
	t.Parallel()

	req := httptest.NewRequest(http.MethodGet, "/api/user/workspaces?state=running&cursor=2&limit=2", nil)
	rec := httptest.NewRecorder()

	// A concurrent write can make the returned row count temporarily shorter
	// than the count query. The next cursor must still advance to page 3.
	setOffsetCursorPaginationHeaders(rec, req, 2, 2, 1, 5)

	link := rec.Header().Get("Link")
	assert.Contains(t, link, `</api/user/workspaces?limit=2&state=running>; rel="first"`)
	assert.Contains(t, link, `</api/user/workspaces?limit=2&state=running>; rel="prev"`)
	assert.Contains(t, link, `cursor=4`)
	assert.Contains(t, link, `rel="next"`)
	assert.NotContains(t, link, "page=")
	assert.NotContains(t, link, "per_page=")
	assert.Equal(t, "5", rec.Header().Get("X-Total-Count"))
	assert.Equal(t, "2", rec.Header().Get("X-Per-Page"))
}

func TestParseUserPagination_LimitMatrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for limit := -20; limit <= 120; limit++ {
		caseCount++

		req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/api/users/alice/repos?cursor=30&limit=%d", limit), nil)
		cursor, gotLimit, err := parseUserPagination(req)

		if limit <= 0 {
			requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "invalid limit")
			assert.Empty(t, cursor)
			assert.Zero(t, gotLimit)
			continue
		}

		require.NoErrorf(t, err, "limit=%d", limit)
		assert.Equalf(t, "30", cursor, "limit=%d", limit)
		if limit > services.UserMaxPerPage {
			assert.Equalf(t, services.UserMaxPerPage, gotLimit, "limit=%d", limit)
		} else {
			assert.Equalf(t, limit, gotLimit, "limit=%d", limit)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "/api/users/alice/repos?cursor=%2030%20", nil)
	cursor, limit, err := parseUserPagination(req)
	require.NoError(t, err)
	assert.Equal(t, "30", cursor)
	assert.Equal(t, services.UserDefaultPerPage, limit)

	req = httptest.NewRequest(http.MethodGet, "/api/users/alice/repos", nil)
	cursor, limit, err = parseUserPagination(req)
	require.NoError(t, err)
	assert.Empty(t, cursor)
	assert.Equal(t, services.UserDefaultPerPage, limit)

	req = httptest.NewRequest(http.MethodGet, "/api/users/alice/repos?limit=abc", nil)
	cursor, limit, err = parseUserPagination(req)
	requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "invalid limit")
	assert.Empty(t, cursor)
	assert.Zero(t, limit)

	req = httptest.NewRequest(http.MethodGet, "/api/users/alice/repos?page=2&per_page=250", nil)
	cursor, limit, err = parseUserPagination(req)
	require.NoError(t, err)
	assert.Equal(t, "100", cursor)
	assert.Equal(t, services.UserMaxPerPage, limit)

	req = httptest.NewRequest(http.MethodGet, "/api/users/alice/repos?page=0", nil)
	cursor, limit, err = parseUserPagination(req)
	requireAPIErrorWithMessage(t, err, http.StatusBadRequest, "invalid page value")
	assert.Empty(t, cursor)
	assert.Zero(t, limit)

	assert.Equal(t, 141, caseCount)
}
