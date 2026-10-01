package services

import (
	"context"
	"fmt"
	"net/http"
	"testing"

	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/internal/repohost"
	"github.com/stretchr/testify/require"
)

func TestGitProxyFailureUploadPackAdmission(t *testing.T) {
	for _, tc := range []struct {
		name           string
		status         int
		responseStatus int
		upstreamCode   string
		code           apierrors.Code
		retry          int
	}{
		{"queue full", http.StatusServiceUnavailable, http.StatusServiceUnavailable, "upload_pack_queue_full", apierrors.CodeServiceUnavailable, 1},
		{"queue timeout", http.StatusServiceUnavailable, http.StatusServiceUnavailable, "upload_pack_queue_timeout", apierrors.CodeServiceUnavailable, 1},
		{"legacy queue timeout", http.StatusGatewayTimeout, http.StatusServiceUnavailable, "upload_pack_queue_timeout", apierrors.CodeServiceUnavailable, 1},
		{"negotiation too large", http.StatusRequestEntityTooLarge, http.StatusRequestEntityTooLarge, "upload_pack_negotiation_too_large", apierrors.CodeRequestEntityTooLarge, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, wrapped := range []bool{false, true} {
				var upstream error = &repohost.StatusError{StatusCode: tc.status, Code: tc.upstreamCode, Message: "secret upstream details", RetryAfter: 900}
				if wrapped {
					upstream = fmt.Errorf("transport: %w", upstream)
				}
				err := gitProxyFailure(context.Background(), "upload-pack", "alice", "demo", upstream)
				var api *apierrors.APIError
				require.ErrorAs(t, err, &api)
				require.Equal(t, tc.responseStatus, api.Status)
				require.Equal(t, tc.code, api.Code)
				require.Equal(t, tc.retry, api.RetryAfter)
				require.NotContains(t, api.Message, "secret")
			}
		})
	}
}

func TestGitProxyFailureDoesNotTranslateUnrelatedAdmissionErrors(t *testing.T) {
	for _, code := range []string{"upload_pack_queue_full", "upload_pack_queue_timeout", "upload_pack_negotiation_too_large", "unrelated"} {
		for _, status := range []int{http.StatusBadRequest, http.StatusServiceUnavailable, http.StatusGatewayTimeout, http.StatusRequestEntityTooLarge} {
			if code == "upload_pack_queue_full" && status == http.StatusServiceUnavailable || code == "upload_pack_queue_timeout" && (status == http.StatusGatewayTimeout || status == http.StatusServiceUnavailable) || code == "upload_pack_negotiation_too_large" && status == http.StatusRequestEntityTooLarge {
				continue
			}
			err := gitProxyFailure(context.Background(), "upload-pack", "alice", "demo", &repohost.StatusError{StatusCode: status, Code: code, Message: "secret upstream details"})
			var api *apierrors.APIError
			require.ErrorAs(t, err, &api)
			require.Equal(t, http.StatusInternalServerError, api.Status)
			require.Equal(t, apierrors.CodeInternal, api.Code)
			require.Zero(t, api.RetryAfter)
			require.NotContains(t, api.Message, "secret")
		}
	}
	for _, err := range []error{fmt.Errorf("secret upstream details"), nil} {
		var api *apierrors.APIError
		require.ErrorAs(t, gitProxyFailure(context.Background(), "upload-pack", "alice", "demo", err), &api)
		require.Equal(t, http.StatusInternalServerError, api.Status)
	}
}

func TestGitProxyFailureDoesNotTranslateAdmissionForOtherOperations(t *testing.T) {
	for _, operation := range []string{"info refs", "receive-pack"} {
		for _, tc := range []struct {
			code   string
			status int
		}{
			{repohost.UploadPackQueueFullCode, http.StatusServiceUnavailable},
			{repohost.UploadPackQueueTimeoutCode, http.StatusGatewayTimeout},
			{repohost.UploadPackNegotiationTooLargeCode, http.StatusRequestEntityTooLarge},
		} {
			var api *apierrors.APIError
			require.ErrorAs(t, gitProxyFailure(context.Background(), operation, "alice", "demo", &repohost.StatusError{StatusCode: tc.status, Code: tc.code}), &api)
			require.Equal(t, http.StatusInternalServerError, api.Status)
		}
	}
}
