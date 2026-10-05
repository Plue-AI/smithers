package httpapi_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/controlstore"
	apierrors "github.com/smithersai/smithers/packages/backend/errors"
	"github.com/smithersai/smithers/packages/backend/httpapi"
	"github.com/smithersai/smithers/packages/backend/operations"
	"github.com/smithersai/smithers/packages/backend/testkit"
	"github.com/stretchr/testify/require"
)

func TestPublicJSONDecodingRequiredOptionalAndByteBoundary(t *testing.T) {
	decoders := []struct {
		name     string
		decode   func(http.ResponseWriter, *http.Request, any) bool
		optional bool
	}{
		{"required", httpapi.DecodeJSONBody, false}, {"optional", httpapi.DecodeOptionalJSONBody, true},
	}
	for _, decoder := range decoders {
		t.Run(decoder.name, func(t *testing.T) {
			for _, tc := range []struct {
				name, body    string
				ok            bool
				status        int
				message, code string
			}{
				{"object", `{"name":"héllo"}`, true, 0, "", ""},
				{"empty", "", decoder.optional, 400, "invalid request body", "bad_request"},
				{"whitespace", " \n\t", decoder.optional, 400, "invalid request body", "bad_request"},
				{"malformed", `{"name":`, false, 400, "invalid request body", "bad_request"},
				{"wrong field type", `{"name":17}`, false, 400, "invalid request body", "bad_request"},
				{"wrong root", `[]`, false, 400, "invalid request body", "bad_request"},
			} {
				t.Run(tc.name, func(t *testing.T) {
					dst := struct {
						Name string `json:"name"`
					}{Name: "unchanged"}
					recorder := httptest.NewRecorder()
					require.Equal(t, tc.ok, decoder.decode(recorder, httptest.NewRequest("POST", "/items", strings.NewReader(tc.body)), &dst))
					if tc.ok {
						require.Empty(t, recorder.Body.String())
						if tc.name == "object" {
							require.Equal(t, "héllo", dst.Name)
						} else {
							require.Equal(t, "unchanged", dst.Name)
						}
					} else {
						require.Equal(t, tc.status, recorder.Code)
						require.JSONEq(t, fmt.Sprintf(`{"message":%q,"code":%q,"class":"user","fault":"user"}`, tc.message, tc.code), recorder.Body.String())
					}
				})
			}
			for _, size := range []int{1048575, 1048576, 1048577} {
				t.Run(fmt.Sprint(size), func(t *testing.T) {
					body := `{"name":"` + strings.Repeat("x", size-11) + `"}`
					require.Len(t, body, size)
					var dst struct {
						Name string `json:"name"`
					}
					recorder := httptest.NewRecorder()
					ok := decoder.decode(recorder, httptest.NewRequest("POST", "/items", strings.NewReader(body)), &dst)
					if size <= 1048576 {
						require.True(t, ok)
						require.Equal(t, strings.Repeat("x", size-11), dst.Name)
						require.Empty(t, recorder.Body.String())
					} else {
						require.False(t, ok)
						require.Equal(t, 413, recorder.Code)
						require.JSONEq(t, `{"message":"request body too large","code":"request_entity_too_large","class":"user","fault":"user"}`, recorder.Body.String())
					}
				})
			}
		})
	}
}

// failingRequestBody is an explicit unit transport boundary, not a socket test.
type failingRequestBody struct{}

func (failingRequestBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (failingRequestBody) Close() error             { return nil }

func TestPublicJSONBodyReadFailureDoesNotExposeTransportDetails(t *testing.T) {
	for _, decode := range []struct {
		name string
		run  func(http.ResponseWriter, *http.Request, any) bool
	}{
		{"required", httpapi.DecodeJSONBody}, {"optional", httpapi.DecodeOptionalJSONBody},
	} {
		t.Run(decode.name, func(t *testing.T) {
			request := httptest.NewRequest("POST", "/items", nil)
			request.Body = failingRequestBody{}
			recorder := httptest.NewRecorder()
			dst := struct{ Name string }{Name: "unchanged"}
			require.False(t, decode.run(recorder, request, &dst))
			require.Equal(t, "unchanged", dst.Name)
			require.Equal(t, 400, recorder.Code)
			require.JSONEq(t, `{"message":"invalid request body","code":"bad_request","class":"user","fault":"user"}`, recorder.Body.String())
			require.NotContains(t, recorder.Body.String(), "unexpected EOF")
		})
	}
}

func TestPublicPaginationAdmissionAndLinkQueryPreservation(t *testing.T) {
	for _, tc := range []struct {
		query, cursor string
		limit         int
		message       string
	}{
		{"", "", 30, ""}, {"limit=1", "", 1, ""}, {"limit=101", "", 100, ""},
		{"cursor=%20opaque%20&per_page=9", "opaque", 9, ""},
		{"page=2&per_page=5", "5", 5, ""},
		{"limit=0", "", 0, "invalid limit value"}, {"limit=-1", "", 0, "invalid limit value"}, {"limit=no", "", 0, "invalid limit value"},
		{"page=0", "", 0, "invalid page value"}, {"page=no", "", 0, "invalid page value"},
		{"per_page=0", "", 0, "invalid per_page value"}, {"per_page=no", "", 0, "invalid per_page value"},
		{"per_page=101", "", 0, "per_page must not exceed 100"},
	} {
		t.Run(tc.query, func(t *testing.T) {
			cursor, limit, err := httpapi.ParsePagination(httptest.NewRequest("GET", "/items?"+tc.query, nil))
			require.Equal(t, tc.cursor, cursor)
			require.Equal(t, tc.limit, limit)
			if tc.message == "" {
				require.NoError(t, err)
			} else {
				var problem *apierrors.APIError
				require.ErrorAs(t, err, &problem)
				require.Equal(t, 400, problem.Status)
				require.Equal(t, tc.message, problem.Message)
				require.Equal(t, "bad_request", string(problem.Code))
				require.Equal(t, "user", string(problem.Fault))
			}
		})
	}
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest("GET", "/items?label=a&label=b&cursor=30&limit=10&page=99&per_page=7", nil)
	httpapi.SetPaginationHeaders(recorder, request, "30", 10, 10, 45)
	require.Equal(t, "45", recorder.Header().Get("X-Total-Count"))
	require.Equal(t, "label=a&label=b&cursor=30&limit=10&page=99&per_page=7", request.URL.RawQuery)
	require.Equal(t, `</items?label=a&label=b&page=1&per_page=10>; rel="first", </items?label=a&label=b&page=5&per_page=10>; rel="last", </items?label=a&label=b&page=3&per_page=10>; rel="prev", </items?label=a&label=b&page=5&per_page=10>; rel="next"`, recorder.Header().Get("Link"))
	for _, tc := range []struct {
		cursor       any
		limit, count int
		total        int64
		link         string
	}{
		{2, 10, 10, 20, `</items?page=1&per_page=10>; rel="first", </items?page=2&per_page=10>; rel="last", </items?page=1&per_page=10>; rel="prev"`},
		{"", 0, 0, 0, `</items?page=1&per_page=30>; rel="first", </items?page=1&per_page=30>; rel="last"`},
	} {
		recorder := httptest.NewRecorder()
		httpapi.SetPaginationHeaders(recorder, httptest.NewRequest("GET", "/items", nil), tc.cursor, tc.limit, tc.count, tc.total)
		require.Equal(t, tc.link, recorder.Header().Get("Link"))
	}

	for _, cursor := range []string{"", "invalid", "-1"} {
		require.Equal(t, 1, httpapi.CursorToPage(cursor, 30))
	}
	require.Equal(t, 2, httpapi.CursorToPage("59", 30))
}

func TestPublicAdminAuditUsesAuthenticatedIdentityAndPeerAddress(t *testing.T) {
	type marker struct{}
	parent := context.WithValue(context.Background(), marker{}, "kept")
	anonymous := httptest.NewRequest("POST", "/admin/users", nil).WithContext(parent)
	require.Same(t, parent, httpapi.AdminUserAuditContext(anonymous))
	_, ok := operations.AdminAuditActorFromContext(parent)
	require.False(t, ok)
	request := anonymous.WithContext(testkit.UserContext(parent, &controlstore.User{ID: 7, Username: "alice"}))
	request.RemoteAddr = "127.0.0.1:5400"
	request.Header.Set("X-Forwarded-For", "198.51.100.17")
	ctx := httpapi.AdminUserAuditContext(request)
	actor, ok := operations.AdminAuditActorFromContext(ctx)
	require.True(t, ok)
	require.Equal(t, operations.AdminAuditActor{UserID: 7, Username: "alice", IPAddress: "127.0.0.1:5400"}, actor)
	require.Equal(t, "kept", ctx.Value(marker{}))
	_, ok = operations.AdminAuditActorFromContext(request.Context())
	require.False(t, ok)
}

func TestPublicRouteErrorsSanitizePrivateDiagnosticsAndPreserveSafePacing(t *testing.T) {
	var logs bytes.Buffer
	original := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(original) })
	secret := "unit-only private dependency diagnostic"
	for _, tc := range []struct {
		name        string
		err         error
		status      int
		body, retry string
	}{
		{"wrapped user refusal", fmt.Errorf("context: %w", apierrors.Forbidden("action refused")), 403, `{"message":"action refused","code":"forbidden","class":"permission","fault":"user"}`, ""},
		{"internal cause", apierrors.Internal("private operation").WithCause(errors.New(secret)), 500, `{"message":"internal server error","code":"internal","class":"infra","fault":"bug"}`, ""},
		{"untyped", errors.New(secret), 500, `{"message":"internal server error","code":"internal","class":"infra","fault":"bug"}`, ""},
		{"dependency", apierrors.New(apierrors.Code("service_unavailable"), secret), 503, `{"message":"service unavailable","code":"service_unavailable","class":"infra","fault":"infra"}`, ""},
		{"safe startup", apierrors.New(apierrors.Code("guest_not_ready"), "guest helpers linking"), 503, `{"message":"guest helpers linking","code":"guest_not_ready","class":"capacity","fault":"wait","retry_after":3}`, "3"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			httpapi.WriteRouteError(recorder, httptest.NewRequest("GET", "/items", nil), tc.err)
			require.Equal(t, tc.status, recorder.Code)
			require.JSONEq(t, tc.body, recorder.Body.String())
			require.Equal(t, tc.retry, recorder.Header().Get("Retry-After"))
			require.NotContains(t, recorder.Body.String(), secret)
		})
	}
	logs.Reset()
	recorder := httptest.NewRecorder()
	// The explicit message is a caller-supplied public sentence; the cause stays in server logs.
	httpapi.WriteInternalError(recorder, httptest.NewRequest("POST", "/items", nil), "internal server error", errors.New(secret))
	require.Equal(t, 500, recorder.Code)
	require.JSONEq(t, `{"message":"internal server error","code":"internal","class":"infra","fault":"bug"}`, recorder.Body.String())
	require.NotContains(t, recorder.Body.String(), secret)
	require.Contains(t, logs.String(), `"method":"POST"`)
	require.Contains(t, logs.String(), `"path":"/items"`)
	require.Contains(t, logs.String(), secret)
}
