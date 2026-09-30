package routes

import (
	"encoding/base64"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// cursorResponse is the standard paginated response envelope.
type cursorResponse struct {
	Items      any    `json:"items"`
	NextCursor string `json:"next_cursor"`
}

// parsePagination extracts cursor-based pagination parameters from a request.
// Returns cursor (opaque string, empty for first page) and limit (default 30, max 100).
func parsePagination(r *http.Request) (cursor string, limit int, err error) {
	return parsePaginationWithLimits(r, 30, 100, "invalid limit value", false)
}

// Offset-backed endpoints accept decimal offsets, never an opaque host cursor.
func parseOffsetPagination(r *http.Request) (string, int, error) {
	return parseOffsetPaginationWithLimits(r, 30, 100, "invalid limit value", false)
}

func parseOffsetPaginationWithLimits(r *http.Request, defaultLimit, maxLimit int, errMsg string, capOversizedLegacy bool) (string, int, error) {
	cursor, limit, err := parsePaginationWithLimits(r, defaultLimit, maxLimit, errMsg, capOversizedLegacy)
	if err != nil {
		return "", 0, err
	}
	if cursor != "" {
		offset, parseErr := strconv.ParseInt(cursor, 10, 64)
		if parseErr != nil || offset < 0 {
			return "", 0, errors.BadRequest("invalid cursor")
		}
	}
	return cursor, limit, nil
}

// parsePaginationWithLimits is the shared implementation for all route-level pagination
// parsers. defaultLimit and maxLimit allow callers to customize bounds; errMsg is the
// error message used when the limit value is invalid.
//
// Legacy page/per_page query parameters are transparently translated to cursor+limit so
// that old API consumers keep working during the migration to cursor-based pagination.
func parsePaginationWithLimits(r *http.Request, defaultLimit, maxLimit int, errMsg string, capOversizedLegacy bool) (cursor string, limit int, err error) {
	if hasLegacyPagination(r.URL.Query()) {
		return parseLegacyPagination(r.URL.Query(), defaultLimit, maxLimit, capOversizedLegacy)
	}

	cursor = strings.TrimSpace(r.URL.Query().Get("cursor"))
	limit = defaultLimit

	// `limit` is the cursor-mode spelling, but a mixed request (cursor +
	// legacy per_page, no limit) must keep its page size too: cursors encode
	// offsets, so silently switching to the default limit would skew the walk.
	rawLimit := strings.TrimSpace(r.URL.Query().Get("limit"))
	if rawLimit == "" {
		rawLimit = strings.TrimSpace(r.URL.Query().Get("per_page"))
	}
	if rawLimit != "" {
		limit, err = strconv.Atoi(rawLimit)
		if err != nil || limit <= 0 {
			return "", 0, errors.BadRequest(errMsg)
		}
		if limit > maxLimit {
			limit = maxLimit
		}
	}

	return cursor, limit, nil
}

func hasLegacyPagination(query url.Values) bool {
	// A cursor ALWAYS wins. Mixed requests (per_page + cursor) previously took
	// the legacy branch and silently IGNORED the cursor — while the response
	// still advertised next_cursor, so a client echoing that cursor back
	// walked page 1 forever without any error to notice.
	if strings.TrimSpace(query.Get("cursor")) != "" {
		return false
	}
	return strings.TrimSpace(query.Get("page")) != "" || strings.TrimSpace(query.Get("per_page")) != ""
}

func parseLegacyPagination(query url.Values, defaultLimit, maxLimit int, capOversized bool) (cursor string, limit int, err error) {
	page := 1
	limit = defaultLimit

	if rawPage := strings.TrimSpace(query.Get("page")); rawPage != "" {
		page, err = strconv.Atoi(rawPage)
		if err != nil || page <= 0 {
			return "", 0, errors.BadRequest("invalid page value")
		}
	}

	if rawPerPage := strings.TrimSpace(query.Get("per_page")); rawPerPage != "" {
		limit, err = strconv.Atoi(rawPerPage)
		if err != nil || limit <= 0 {
			return "", 0, errors.BadRequest("invalid per_page value")
		}
		if limit > maxLimit {
			if capOversized {
				limit = maxLimit
			} else {
				return "", 0, errors.BadRequest("per_page must not exceed 100")
			}
		}
	}

	offset, ok := pageToOffset(page, limit)
	if !ok {
		return "", 0, errors.BadRequest("page offset is too large")
	}
	return offsetToCursor(offset), limit, nil
}

// pageToOffset converts a positive page and limit without wrapping the int64
// cursor domain. Both legacy input and adjacent-page links use this boundary.
func pageToOffset(page, limit int) (int64, bool) {
	pages := int64(page - 1)
	if pages > math.MaxInt64/int64(limit) {
		return 0, false
	}
	return pages * int64(limit), true
}

// parseKeysetPagination parses pagination for keyset-cursor endpoints, returning
// the decoded after-ID cursor and page size. Legacy page/per_page requests
// CANNOT be translated for these endpoints: the legacy path converts the page
// to a decimal offset cursor, and a keyset endpoint would misread that offset
// as an entity number, silently skipping or duplicating rows. page=1 (an
// explicit first page) is honored along with per_page; any later page is
// rejected so clients follow the cursor from the Link header instead.
func parseKeysetPagination(r *http.Request) (afterID int64, limit int, err error) {
	query := r.URL.Query()
	if hasLegacyPagination(query) {
		cursor, limit, err := parseLegacyPagination(query, 30, 100, false)
		if err != nil {
			return 0, 0, err
		}
		if cursor != "" {
			return 0, 0, errors.BadRequest("page-based pagination is not supported by this endpoint; follow the cursor from the Link header")
		}
		return 0, limit, nil
	}

	cursor, limit, err := parsePagination(r)
	if err != nil {
		return 0, 0, err
	}
	if cursor != "" && !validIDCursor(cursor) {
		return 0, 0, errors.BadRequest("invalid cursor")
	}
	return decodeIDCursor(cursor), limit, nil
}

func validIDCursor(cursor string) bool {
	if id, err := strconv.ParseInt(cursor, 10, 64); err == nil && id >= 0 {
		return true
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return false
	}
	id, err := strconv.ParseInt(string(decoded), 10, 64)
	return err == nil && id >= 0
}

// cursorToOffset converts an opaque cursor to a numeric offset for services
// that still use offset-based pagination internally. Returns 0 for empty/invalid cursors.
// This is a migration bridge; services should be updated to cursor-based pagination.
func cursorToOffset(cursor string) int64 {
	if cursor == "" {
		return 0
	}
	offset, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil || offset < 0 {
		return 0
	}
	return offset
}

// clampOffsetInt32 narrows an int64 SQL offset to int32, clamping instead of
// wrapping a large cursor value to a negative int32 offset — a negative OFFSET
// 500s the query. An absurd offset yields an empty final page instead.
func clampOffsetInt32(offset int64) int32 {
	if offset < 0 {
		return 0
	}
	if offset > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(offset)
}

// cursorToPage converts a cursor and limit into a 1-based page number.
// Bridge helper for services that still accept (page, perPage) parameters.
// Pages beyond the platform int range saturate at its maximum.
func cursorToPage(cursor string, limit int) int {
	offset := cursorToOffset(cursor)
	if limit <= 0 {
		limit = 30
	}
	return offsetToPage(offset, limit)
}

// offsetToPage narrows a nonnegative offset with a positive limit to the legacy
// int page domain. Unrepresentable pages saturate rather than wrap to page one.
func offsetToPage(offset int64, limit int) int {
	pageIndex := offset / int64(limit)
	if pageIndex >= int64(math.MaxInt) {
		return math.MaxInt
	}
	return int(pageIndex) + 1
}

// offsetToCursor converts a numeric offset to an opaque cursor string.
// Returns empty string for offset 0 (first page).
func offsetToCursor(offset int64) string {
	if offset <= 0 {
		return ""
	}
	return strconv.FormatInt(offset, 10)
}

// encodeIDCursor encodes a numeric last-seen ID into an opaque base64 cursor.
// Returns "" for id <= 0 (represents no cursor / first page).
func encodeIDCursor(id int64) string {
	if id <= 0 {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(id, 10)))
}

// decodeIDCursor decodes an opaque cursor back to a numeric ID.
// Returns 0 for empty or malformed cursors (first-page sentinel).
func decodeIDCursor(cursor string) int64 {
	cursor = strings.TrimSpace(cursor)
	if cursor == "" {
		return 0
	}
	b, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return decodePlainIDCursor(cursor)
	}
	id, err := strconv.ParseInt(string(b), 10, 64)
	if err != nil || id < 0 {
		return decodePlainIDCursor(cursor)
	}
	return id
}

func decodePlainIDCursor(cursor string) int64 {
	id, err := strconv.ParseInt(cursor, 10, 64)
	if err != nil || id < 0 {
		return 0
	}
	return id
}

// setCursorPaginationHeaders sets Link, X-Total-Count, X-Page, and X-Per-Page
// headers for cursor-based pagination responses.
// page is 1-based; pass 0 if unknown (header will be omitted).
func setCursorPaginationHeaders(w http.ResponseWriter, r *http.Request, limit int, nextCursor string) {
	links := []string{
		fmt.Sprintf("<%s>; rel=\"first\"", paginationURL(r, limit, "")),
	}
	if nextCursor != "" {
		links = append(links,
			fmt.Sprintf("<%s>; rel=\"next\"", paginationURL(r, limit, nextCursor)),
		)
	}
	w.Header().Set("Link", strings.Join(links, ", "))
	w.Header().Set("X-Per-Page", strconv.Itoa(limit))
}

// setFullCursorPaginationHeaders sets all Gitea-compatible pagination headers
// for a keyset-paginated response. It sets Link (with rel=next/prev if applicable),
// X-Total-Count, X-Page, and X-Per-Page.
func setFullCursorPaginationHeaders(w http.ResponseWriter, r *http.Request, limit int, total int64, nextCursor string) {
	setCursorPaginationHeaders(w, r, limit, nextCursor)
	w.Header().Set("X-Total-Count", strconv.FormatInt(total, 10))
}

// setOffsetCursorPaginationHeaders sets cursor-form pagination headers for a
// route whose service still uses page/limit offsets. The cursor remains opaque
// to clients even though the route can cheaply derive both adjacent offsets.
func setOffsetCursorPaginationHeaders(w http.ResponseWriter, r *http.Request, page, limit, resultCount int, total int64) {
	if page < 1 {
		page = 1
	}
	if limit < 1 {
		limit = 30
	}

	currentOffset, currentRepresentable := pageToOffset(page, limit)
	links := []string{
		fmt.Sprintf("<%s>; rel=\"first\"", paginationURL(r, limit, "")),
	}
	if page > 1 {
		if previousOffset, ok := pageToOffset(page-1, limit); ok {
			links = append(links,
				fmt.Sprintf("<%s>; rel=\"prev\"", paginationURL(r, limit, offsetToCursor(previousOffset))),
			)
		}
	}
	if resultCount > 0 && currentRepresentable && currentOffset <= math.MaxInt64-int64(limit) {
		// The backing service advances in whole pages, so the cursor must stay
		// aligned to limit even if concurrent writes make resultCount and total
		// briefly disagree.
		nextOffset := currentOffset + int64(limit)
		if nextOffset < total {
			links = append(links,
				fmt.Sprintf("<%s>; rel=\"next\"", paginationURL(r, limit, offsetToCursor(nextOffset))),
			)
		}
	}

	w.Header().Set("Link", strings.Join(links, ", "))
	w.Header().Set("X-Total-Count", strconv.FormatInt(total, 10))
	w.Header().Set("X-Per-Page", strconv.Itoa(limit))
}

// setPaginationHeaders is a bridge for handlers whose services still return total count.
// It computes a synthetic next_cursor when more results exist beyond the current offset.
// Once all services migrate to native cursor-based pagination, replace with setCursorPaginationHeaders.
func setPaginationHeaders(w http.ResponseWriter, r *http.Request, cursorOrPage any, limit int, resultCount int, total int64) {
	w.Header().Set("X-Total-Count", strconv.FormatInt(total, 10))

	currentPage := 1
	if page, ok := legacyPageValue(r, cursorOrPage, limit); ok {
		currentPage = page
	} else if cursor, ok := cursorOrPage.(string); ok {
		currentPage = cursorToPage(cursor, limit)
	}
	setLegacyPaginationHeaders(w, r, currentPage, limit, total)
}

func paginationURL(r *http.Request, pageOrLimit int, cursorOrPerPage any) string {
	q := url.Values{}
	for k, vals := range r.URL.Query() {
		if k == "cursor" || k == "limit" || k == "page" || k == "per_page" {
			continue
		}
		for _, val := range vals {
			q.Add(k, val)
		}
	}

	switch value := cursorOrPerPage.(type) {
	case string:
		q.Set("limit", strconv.Itoa(pageOrLimit))
		if value != "" {
			q.Set("cursor", value)
		}
	case int:
		q.Set("page", strconv.Itoa(pageOrLimit))
		q.Set("per_page", strconv.Itoa(value))
	default:
		q.Set("limit", strconv.Itoa(pageOrLimit))
	}

	return paginationURLWithQuery(r.URL.Path, q)
}

func paginationURLWithQuery(path string, q url.Values) string {
	encoded := q.Encode()
	if encoded == "" {
		return path
	}
	return path + "?" + encoded
}

func legacyPageValue(r *http.Request, cursorOrPage any, limit int) (int, bool) {
	if page, ok := cursorOrPage.(int); ok {
		return page, true
	}
	if hasLegacyPagination(r.URL.Query()) {
		if cursor, ok := cursorOrPage.(string); ok {
			return cursorToPage(cursor, limit), true
		}
	}
	return 0, false
}

func setLegacyPaginationHeaders(w http.ResponseWriter, r *http.Request, page, perPage int, total int64) {
	if perPage <= 0 {
		perPage = 30
	}

	lastPage := 1
	if total > 0 {
		lastPage = offsetToPage(total-1, perPage)
	}

	links := []string{
		fmt.Sprintf("<%s>; rel=\"first\"", paginationURL(r, 1, perPage)),
		fmt.Sprintf("<%s>; rel=\"last\"", paginationURL(r, lastPage, perPage)),
	}
	if page > 1 {
		links = append(links, fmt.Sprintf("<%s>; rel=\"prev\"", paginationURL(r, page-1, perPage)))
	}
	if page < lastPage {
		links = append(links, fmt.Sprintf("<%s>; rel=\"next\"", paginationURL(r, page+1, perPage)))
	}

	w.Header().Set("Link", strings.Join(links, ", "))
}
