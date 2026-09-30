package routes

import (
	"context"
	"encoding/json"
	stdErrors "errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
)

// signupProfileMemory is onboarding_answers in memory: one document per user.
type signupProfileMemory struct {
	rows map[int64]json.RawMessage
	fail error
}

func (m *signupProfileMemory) GetOnboardingAnswers(_ context.Context, userID int64) (db.GetOnboardingAnswersRow, error) {
	if m.fail != nil {
		return db.GetOnboardingAnswersRow{}, m.fail
	}
	row, ok := m.rows[userID]
	if !ok {
		return db.GetOnboardingAnswersRow{}, pgx.ErrNoRows
	}
	return db.GetOnboardingAnswersRow{Answers: row, UpdatedAt: pgtype.Timestamptz{Time: time.Unix(1_790_000_000, 0), Valid: true}}, nil
}

func (m *signupProfileMemory) UpsertOnboardingAnswers(_ context.Context, arg db.UpsertOnboardingAnswersParams) (db.UpsertOnboardingAnswersRow, error) {
	if m.fail != nil {
		return db.UpsertOnboardingAnswersRow{}, m.fail
	}
	m.rows[arg.UserID] = arg.Answers
	return db.UpsertOnboardingAnswersRow{Answers: arg.Answers, UpdatedAt: pgtype.Timestamptz{Time: time.Unix(1_790_000_000, 0), Valid: true}}, nil
}

func signupProfileRequest(t *testing.T, h *UserHandler, method string, body string, userID int64) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/api/user/settings/signup", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if userID != 0 {
		req = withAuth(req, userID, "user")
	}
	rec := httptest.NewRecorder()
	if method == http.MethodGet {
		h.GetSignupProfile(rec, req)
	} else {
		h.PutSignupProfile(rec, req)
	}
	return rec
}

const signupProfileBody = `{"name":"Ada Park","account":"adapark","stage":"poll","question":5,"answers":{"size":"2–10","models":["Codex","Claude"],"repo":"new"},"repo":"new"}`

func TestSignupProfileWriteThenReadBack(t *testing.T) {
	h := &UserHandler{SignupProfiles: services.NewSignupProfileService(&signupProfileMemory{rows: map[int64]json.RawMessage{}})}

	empty := signupProfileRequest(t, h, http.MethodGet, "", 10)
	require.Equal(t, http.StatusOK, empty.Code)
	require.JSONEq(t, `{"profile":null}`, empty.Body.String())

	put := signupProfileRequest(t, h, http.MethodPut, signupProfileBody, 10)
	require.Equal(t, http.StatusOK, put.Code, put.Body.String())
	want := `{"profile":` + signupProfileBody + `,"updated_at":"2026-09-21T14:13:20Z"}`
	require.JSONEq(t, want, put.Body.String())

	got := signupProfileRequest(t, h, http.MethodGet, "", 10)
	require.Equal(t, http.StatusOK, got.Code)
	require.JSONEq(t, want, got.Body.String())

	// A later write replaces the whole document.
	next := `{"name":"Ada Park","account":"ada","stage":"done","question":6,"answers":{}}`
	require.Equal(t, http.StatusOK, signupProfileRequest(t, h, http.MethodPut, next, 10).Code)
	require.JSONEq(t, `{"profile":`+next+`,"updated_at":"2026-09-21T14:13:20Z"}`, signupProfileRequest(t, h, http.MethodGet, "", 10).Body.String())
}

func TestSignupProfileIsTheSessionUsersOwn(t *testing.T) {
	h := &UserHandler{SignupProfiles: services.NewSignupProfileService(&signupProfileMemory{rows: map[int64]json.RawMessage{}})}
	require.Equal(t, http.StatusOK, signupProfileRequest(t, h, http.MethodPut, signupProfileBody, 10).Code)

	other := signupProfileRequest(t, h, http.MethodGet, "", 11)
	require.Equal(t, http.StatusOK, other.Code)
	require.JSONEq(t, `{"profile":null}`, other.Body.String())
}

func TestSignupProfileRefusals(t *testing.T) {
	store := &signupProfileMemory{rows: map[int64]json.RawMessage{}}
	h := &UserHandler{SignupProfiles: services.NewSignupProfileService(store)}
	tests := []struct {
		name       string
		method     string
		body       string
		userID     int64
		fail       error
		wantStatus int
		wantCode   string
	}{
		{"read without a session", http.MethodGet, "", 0, nil, http.StatusUnauthorized, "unauthorized"},
		{"write without a session", http.MethodPut, signupProfileBody, 0, nil, http.StatusUnauthorized, "unauthorized"},
		{"malformed body", http.MethodPut, `{"name":`, 10, nil, http.StatusBadRequest, "bad_request"},
		{"answer is neither text nor choices", http.MethodPut, `{"name":"A","account":"ab","stage":"poll","question":0,"answers":{"size":1}}`, 10, nil, http.StatusBadRequest, "bad_request"},
		{"empty name", http.MethodPut, `{"name":"","account":"ab","stage":"poll","question":0,"answers":{}}`, 10, nil, http.StatusUnprocessableEntity, "validation_failed"},
		{"invalid account", http.MethodPut, `{"name":"A","account":"-ab","stage":"poll","question":0,"answers":{}}`, 10, nil, http.StatusUnprocessableEntity, "validation_failed"},
		{"one-letter account", http.MethodPut, `{"name":"A","account":"a","stage":"poll","question":0,"answers":{}}`, 10, nil, http.StatusUnprocessableEntity, "validation_failed"},
		{"stage before the claim", http.MethodPut, `{"name":"A","account":"ab","stage":"account","question":0,"answers":{}}`, 10, nil, http.StatusUnprocessableEntity, "validation_failed"},
		{"negative question", http.MethodPut, `{"name":"A","account":"ab","stage":"poll","question":-1,"answers":{}}`, 10, nil, http.StatusUnprocessableEntity, "validation_failed"},
		{"oversized answer", http.MethodPut, `{"name":"A","account":"ab","stage":"poll","question":0,"answers":{"more":"` + strings.Repeat("x", 2001) + `"}}`, 10, nil, http.StatusUnprocessableEntity, "validation_failed"},
		{"read store failure", http.MethodGet, "", 10, stdErrors.New("connection refused"), http.StatusServiceUnavailable, "profile_unavailable"},
		{"write store failure", http.MethodPut, signupProfileBody, 10, stdErrors.New("connection refused"), http.StatusServiceUnavailable, "profile_unavailable"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store.fail = tt.fail
			rec := signupProfileRequest(t, h, tt.method, tt.body, tt.userID)
			require.Equal(t, tt.wantStatus, rec.Code, rec.Body.String())
			var body struct {
				Code  string `json:"code"`
				Fault string `json:"fault"`
			}
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
			require.Equal(t, tt.wantCode, body.Code)
			if tt.wantCode == "profile_unavailable" {
				require.Equal(t, "infra", body.Fault)
				require.Equal(t, "1", rec.Header().Get("Retry-After"))
				require.NotContains(t, rec.Body.String(), "connection refused")
			}
		})
	}
	require.Empty(t, store.rows, "no refused write reached the store")
}
