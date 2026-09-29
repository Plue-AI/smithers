package services

import (
	"math"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// CheckedPageOffset keeps a normalized page inside the SQL offset type.
func CheckedPageOffset(page, perPage int, maxOffset int64) (int64, error) {
	if page < 1 || perPage < 1 || int64(page-1) > maxOffset/int64(perPage) {
		return 0, pkgerrors.BadRequest("page offset is too large")
	}
	return int64(page-1) * int64(perPage), nil
}

// ClampInt32 converts x to int32, clamping out-of-range values instead of letting
// a large int wrap to a negative int32. Used for SQL OFFSET/LIMIT values derived
// from user-supplied page/cursor input: an unbounded page or cursor makes
// (page-1)*perPage exceed math.MaxInt32, and a plain int32() conversion wraps to a
// negative offset that 500s the query. Negative inputs clamp to 0; an absurdly
// large offset yields an empty final page instead of an error.
func ClampInt32(x int) int32 {
	if x < 0 {
		return 0
	}
	if x > math.MaxInt32 {
		return math.MaxInt32
	}
	return int32(x)
}
