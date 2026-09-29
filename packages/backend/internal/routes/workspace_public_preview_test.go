package routes

import (
	"context"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/smithersai/smithers/packages/backend/previewgateway"
	"github.com/stretchr/testify/require"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type publicPreviewRouteAuthorizer struct {
	revocablePreviewAuthorizer
	domain string
	err    error
	calls  int
}

func (a *publicPreviewRouteAuthorizer) AuthorizePublicPreview(_ context.Context, domain string) error {
	a.domain = domain
	a.calls++
	return a.err
}
func TestPublicPreviewAuthorizationBoundary(t *testing.T) {
	a := &publicPreviewRouteAuthorizer{}
	h := &WorkspacePreviewTicketHandler{Service: a, Tickets: previewgateway.NewTickets("01234567890123456789012345678901")}
	request := func(body string) int {
		rec := httptest.NewRecorder()
		h.Authorize(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
		return rec.Code
	}
	const body = `{"domain":"3000-11111111-1111-4111-8111-111111111111.preview.jjhub.tech"}`
	require.Equal(t, http.StatusNoContent, request(body))
	require.Equal(t, "3000-11111111-1111-4111-8111-111111111111.preview.jjhub.tech", a.domain)
	a.err = pkgerrors.Forbidden("private")
	require.Equal(t, http.StatusForbidden, request(body))
	a.err = pkgerrors.Internal("down")
	require.Equal(t, http.StatusInternalServerError, request(body))
	before := a.calls
	require.Equal(t, http.StatusForbidden, request(`{"ticket":"invalid","domain":"public"}`))
	require.Equal(t, before, a.calls)
	require.Equal(t, http.StatusForbidden, request(`{}`))
	require.Equal(t, before, a.calls)
}
