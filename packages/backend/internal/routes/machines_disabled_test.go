package routes

import (
	apierrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"testing"
)

func TestMachinesDisabledMessageSurvivesScrubbing(t *testing.T) {
	writer := httptest.NewRecorder()
	writeRouteError(writer, httptest.NewRequest("POST", "/invoke", nil), apierrors.New(apierrors.CodeMachinesDisabled, "Machines are off in this preview."))
	require.Equal(t, 503, writer.Code)
	require.JSONEq(t, `{"code":"machines_disabled","fault":"infra","message":"Machines are off in this preview."}`, writer.Body.String())
	require.Empty(t, writer.Header().Get("Retry-After"))
}
