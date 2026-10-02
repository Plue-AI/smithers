package services

import (
	"errors"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func httpStatus(err error) int {
	var apiErr *pkgerrors.APIError
	if errors.As(err, &apiErr) {
		return apiErr.Status
	}
	return 0
}
