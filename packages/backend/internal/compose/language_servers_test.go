package compose

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/machined"
	"github.com/smithersai/smithers/packages/backend/internal/routes"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

// receiptGateRuntime is an installed member runtime: sandboxed, with machine
// admission and member sessions. Nothing here is called; availability reads
// only its shape.
type receiptGateRuntime struct{ workspaceapi.WorkspaceRuntime }

func (receiptGateRuntime) Isolation() workspaceapi.IsolationLevel {
	return workspaceapi.IsolationSandboxed
}
func (receiptGateRuntime) EnsureMachined(context.Context, string) error { return nil }
func (receiptGateRuntime) WaitAdmission(ctx context.Context, _ microsandbox.AdmissionProviders, _, _, _, _ string) (context.Context, error) {
	return ctx, nil
}
func (receiptGateRuntime) SessionCredentialsForMember(context.Context, string, microsandbox.MemberIdentity) (microsandbox.MemberSessionCredentials, error) {
	return nil, errors.New("no session in this test")
}

type receiptGateTransactions struct{}

func (receiptGateTransactions) Begin(context.Context) (pgx.Tx, error) {
	return nil, errors.New("no transaction in this test")
}

// smithers-8a, 2026-10-07 (#3556): the language server's root inputs need
// their own C-COL-04 receipt. Until it is committed, an install whose member
// runtime could start language servers advertises no code.intelligence and
// both doors refuse before any authorization, session or wake.
func TestCodeIntelligenceStaysDarkWithoutTheConfinementReceipt(t *testing.T) {
	q := db.New(nil)
	runtime := receiptGateRuntime{}
	branches := services.NewWorkspaceService(q,
		services.WithWorkspaceTransactions(receiptGateTransactions{}),
		services.WithWorkspaceRuntime(runtime),
		services.WithBranchMachineProviders(services.InstallBranchMachineProviders(identity.NewMemberBoundary(q), runtime)),
		services.WithWorkspaceCredentialIssuer(&services.AuthService{}),
		services.WithWorkspaceGitBaseURL("http://127.0.0.1:4000"))
	branches.EnableMachineAdmission(func(context.Context) (int64, error) { return 100 << 30, nil })
	registry := new(machined.Registry)
	require.True(t, branches.LanguageServerAvailable(registry), "the member runtime can start language servers")

	require.Empty(t, lspConfinementReceipt, "C-COL-04's language-server receipt has not passed on the reference host")
	dark := newInstallLanguageServers(q, branches, registry)
	require.False(t, dark.Available())
	require.NotContains(t, newAppBootstrap(bootstrapFeatures{install: true, codeIntelligence: dark.Available()}).Capabilities, "code.intelligence")
	authorized := 0
	handler := &routes.BranchLSPHandler{Provider: dark, Authorize: func(*http.Request, string) (int64, int64, error) { authorized++; return 1, 1, nil }}
	for _, door := range []struct {
		method, path string
		serve        http.HandlerFunc
	}{
		{http.MethodPost, "/api/branches/scratch%2Fmaya%2Fone/lsp", handler.Open},
		{http.MethodGet, "/api/branches/scratch%2Fmaya%2Fone/lsp/s1", handler.Socket},
	} {
		out := httptest.NewRecorder()
		door.serve(out, httptest.NewRequest(door.method, door.path, strings.NewReader(`{"language":"typescript"}`)))
		require.Equal(t, http.StatusServiceUnavailable, out.Code, "%s %s", door.method, door.path)
		require.Contains(t, out.Body.String(), "Code intelligence is unavailable")
	}
	require.Zero(t, authorized, "a dark door makes no command decision")

	// The control: the same runtime with a committed receipt is advertised.
	lit := newInstallLanguageServers(q, branches, registry)
	lit.receipt = "C-COL-04/reference-host"
	require.True(t, lit.Available())
	require.Contains(t, newAppBootstrap(bootstrapFeatures{install: true, codeIntelligence: lit.Available()}).Capabilities, "code.intelligence")
}
