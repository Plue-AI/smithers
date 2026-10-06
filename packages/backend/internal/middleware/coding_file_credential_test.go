package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/stretchr/testify/require"
)

type codingFileBrokenBody struct{ closed bool }

func (*codingFileBrokenBody) Read([]byte) (int, error) {
	return 0, errors.New("private reader failure")
}
func (b *codingFileBrokenBody) Close() error { b.closed = true; return nil }

const fileGrantBody = `{"changes":[{"path":"a.txt","base_digest":"absent","content":"hi"}]}`

func fileGrantFixture() (*AuthInfo, CodingFileBinding) {
	digest := sha256.Sum256([]byte(fileGrantBody))
	b := CodingFileBinding{HostID: "11111111-1111-4111-a111-111111111111", WorkspaceID: "22222222-2222-4222-a222-222222222222",
		RepositoryID: 7, RunID: "Run-A", BatchDigest: hex.EncodeToString(digest[:]), Fence: strings.Repeat("b", 64)}
	return &AuthInfo{User: &db.User{ID: 1}, IsTokenAuth: true, TokenSystemIssued: true, RawScopes: strings.Join(CodingFileScopes(b), ",")}, b
}

func TestCodingFileCredentialScopes(t *testing.T) {
	info, binding := fileGrantFixture()
	actual, ok := CodingFileCredential(info)
	require.True(t, ok)
	require.Equal(t, binding, actual)
	require.Equal(t, CredentialDelegated, info.CredentialKind())
	require.True(t, info.IsResourceBound())
	require.True(t, ParseTokenScopes(info.RawScopes).Has(ScopeWriteRepository))
	require.False(t, ParseTokenScopes(info.RawScopes).Has(ScopeWriteApproval))
	for _, change := range []func(*AuthInfo){
		func(a *AuthInfo) { a.TokenSystemIssued = false },
		func(a *AuthInfo) { a.IsTokenAuth = false },
		func(a *AuthInfo) { a.RawScopes += ",profile:" + CodingFileProfileS1 },
		func(a *AuthInfo) { a.RawScopes += ",admin" },
		func(a *AuthInfo) { a.RawScopes += ",read:repository" },
		func(a *AuthInfo) { a.RawScopes = strings.ReplaceAll(a.RawScopes, "via:smithers", "via:terminal") },
		func(a *AuthInfo) { a.RawScopes = strings.ReplaceAll(a.RawScopes, "repo:7", "repo:07") },
		func(a *AuthInfo) {
			a.RawScopes = strings.ReplaceAll(a.RawScopes, "profile:"+CodingFileProfileS1+",", "")
		},
		func(a *AuthInfo) { a.RawScopes = strings.ReplaceAll(a.RawScopes, binding.HostID, "bad-host") },
		func(a *AuthInfo) { a.RawScopes = strings.ReplaceAll(a.RawScopes, binding.WorkspaceID, "bad-workspace") },
		func(a *AuthInfo) { a.RawScopes = strings.ReplaceAll(a.RawScopes, binding.BatchDigest, "bad-digest") },
		func(a *AuthInfo) {
			a.RawScopes = strings.ReplaceAll(a.RawScopes, "agent-session:Run-A", "agent-session:bad run")
		},
	} {
		candidate, _ := fileGrantFixture()
		change(candidate)
		_, ok := CodingFileCredential(candidate)
		require.False(t, ok, "%s", candidate.RawScopes)
	}
	_, ok = CodingFileCredential(nil)
	require.False(t, ok)
}

func TestCodingFileCredentialAdmitsOnlyExactBoundedBody(t *testing.T) {
	info, binding := fileGrantFixture()
	path := "/api/repos/owner/repo/workspaces/" + binding.WorkspaceID + "/files/content"
	request := httptest.NewRequest(http.MethodPut, path, strings.NewReader(fileGrantBody))
	require.True(t, allowCodingFileCredential(httptest.NewRecorder(), request, info))
	data, err := io.ReadAll(request.Body)
	require.NoError(t, err)
	require.Equal(t, fileGrantBody, string(data), "handler receives original bytes")
	require.True(t, CodingFileBatchVerified(info, binding.BatchDigest))
	for _, tc := range []struct{ method, path, body string }{
		{"GET", path, fileGrantBody}, {"POST", path, fileGrantBody},
		{"PUT", path + "?path=other", fileGrantBody}, {"PUT", strings.Replace(path, binding.WorkspaceID, binding.HostID, 1), fileGrantBody},
		{"PUT", "/api/user/tokens", fileGrantBody}, {"PUT", path + "/extra", fileGrantBody},
		{"PUT", strings.Replace(path, "/files/", "/services/", 1), fileGrantBody},
		{"PUT", strings.Replace(path, "/owner/", "//", 1), fileGrantBody},
		{"PUT", path, fileGrantBody + " "}, {"PUT", path, strings.Repeat("x", 1024*1024+1)},
	} {
		fresh, _ := fileGrantFixture()
		recorder := httptest.NewRecorder()
		require.False(t, allowCodingFileCredential(recorder, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)), fresh))
		require.Equal(t, http.StatusForbidden, recorder.Code)
		require.False(t, CodingFileBatchVerified(fresh, binding.BatchDigest))
	}
	ordinary := &AuthInfo{IsTokenAuth: true, User: &db.User{ID: 1}, RawScopes: "write:repository"}
	require.True(t, allowCodingFileCredential(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil), ordinary))
	malformed, _ := fileGrantFixture()
	malformed.RawScopes = "write:repository,coding-file-batch:invalid"
	require.False(t, allowCodingFileCredential(httptest.NewRecorder(), request, malformed))
	for _, nilBody := range []bool{false, true} {
		fresh, _ := fileGrantFixture()
		req := httptest.NewRequest("PUT", path, nil)
		broken := &codingFileBrokenBody{}
		if nilBody {
			req.Body = nil
		} else {
			req.Body = broken
		}
		recorder := httptest.NewRecorder()
		require.False(t, allowCodingFileCredential(recorder, req, fresh))
		require.Equal(t, !nilBody, broken.closed)
		require.NotContains(t, recorder.Body.String(), "private reader failure")
	}
}
