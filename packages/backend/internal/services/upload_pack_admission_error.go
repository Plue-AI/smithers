package services

import (
	"net/http"

	"github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
)

// uploadPackAdmissionError translates only known admission refusals. Upstream
// messages and retry values never become public responses.
func uploadPackAdmissionError(err error) *errors.APIError {
	status, ok := repohost.IsStatusError(err)
	if !ok {
		return nil
	}
	switch {
	case status.StatusCode == http.StatusServiceUnavailable && status.Code == repohost.UploadPackQueueFullCode:
		refusal := errors.New(errors.CodeServiceUnavailable, "upload-pack queue is full")
		refusal.RetryAfter = 1
		return refusal
	case (status.StatusCode == http.StatusServiceUnavailable || status.StatusCode == http.StatusGatewayTimeout) && status.Code == repohost.UploadPackQueueTimeoutCode:
		refusal := errors.New(errors.CodeServiceUnavailable, "upload-pack admission timed out")
		refusal.RetryAfter = 1
		return refusal
	case status.StatusCode == http.StatusRequestEntityTooLarge && status.Code == repohost.UploadPackNegotiationTooLargeCode:
		return errors.RequestEntityTooLarge("upload-pack negotiation is too large")
	default:
		return nil
	}
}
