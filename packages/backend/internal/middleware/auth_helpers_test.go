package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/assert"

	"github.com/smithersai/smithers/packages/backend/flowhost"
	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestFlowhostModelCredentialNeverExtractedAsUserToken(t *testing.T) {
	t.Parallel()
	credential := flowhost.ModelCredential("64e8df81-00a9-41a9-bba8-01e81786c49a", "control-secret")
	assert.True(t, strings.HasPrefix(credential, flowhost.ModelCredentialPrefix))
	assert.False(t, isValidTokenFormat(credential), "a valid model credential is not a user token")
	assert.False(t, isValidTokenFormat("smithers_flowhost_"+strings.Repeat("a", 40)), "a flow host credential with a hex suffix is not a user token")

	userToken := "smithers_" + strings.Repeat("a", 40)
	for _, scheme := range []string{"Bearer", "token"} {
		t.Run(scheme, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/user", nil)
			request.Header.Set("Authorization", scheme+" "+credential)
			assert.Empty(t, ExtractToken(request))
			request.Header.Set("Authorization", scheme+" "+userToken)
			assert.Equal(t, userToken, ExtractToken(request), "control: accepted user token")
		})
	}
	t.Run("Basic", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/user", nil)
		request.SetBasicAuth("alice", credential)
		assert.Empty(t, ExtractToken(request))
		request.SetBasicAuth("alice", userToken)
		assert.Equal(t, userToken, ExtractToken(request), "control: accepted user token")
	})
}

func TestIsValidTokenFormat_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for _, ch := range "0123456789abcdef" {
		caseCount++
		assert.True(t, isValidTokenFormat("smithers_"+strings.Repeat(string(ch), 40)))

		caseCount++
		assert.True(t, isValidTokenFormat("smithers_oat_"+strings.Repeat(string(ch), 64)))
	}

	for length := 38; length <= 42; length++ {
		caseCount++
		assert.Equal(t, length == 40, isValidTokenFormat("smithers_"+strings.Repeat("a", length)))
	}

	for length := 62; length <= 66; length++ {
		caseCount++
		assert.Equal(t, length == 64, isValidTokenFormat("smithers_oat_"+strings.Repeat("a", length)))
	}

	invalidTokens := []string{
		"",
		"smithers_",
		"smithers_oat_",
		"smithers_" + strings.Repeat("A", 40),
		"smithers_oat_" + strings.Repeat("A", 64),
		"smithers_" + strings.Repeat("g", 40),
		"smithers_oat_" + strings.Repeat("g", 64),
		"smithers_" + strings.Repeat("-", 40),
		"token_" + strings.Repeat("a", 40),
	}

	for _, token := range invalidTokens {
		caseCount++
		assert.False(t, isValidTokenFormat(token), token)
	}

	assert.Equal(t, 51, caseCount)
}

func TestHasHexTail_Matrix(t *testing.T) {
	t.Parallel()

	caseCount := 0
	for _, ch := range "0123456789abcdef" {
		caseCount++
		assert.True(t, hasHexTail(strings.Repeat(string(ch), 8), 8))
	}

	tests := []struct {
		tail string
		size int
		want bool
	}{
		{tail: "", size: 0, want: true},
		{tail: "abcdef", size: 5, want: false},
		{tail: "abcde", size: 6, want: false},
		{tail: "ABCDEF", size: 6, want: false},
		{tail: "abcdeg", size: 6, want: false},
		{tail: "abcd-e", size: 6, want: false},
		{tail: "12345 ", size: 6, want: false},
	}

	for _, tc := range tests {
		caseCount++
		assert.Equal(t, tc.want, hasHexTail(tc.tail, tc.size))
	}

	assert.Equal(t, 23, caseCount)
}

func TestAuthRowToUser_FieldMapping(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_700_200_000, 0).UTC()
	row := db.GetAuthInfoByTokenHashRow{
		ID:            99,
		Username:      "alice",
		LowerUsername: "alice",
		Email:         pgtype.Text{String: "alice@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "alice@example.com", Valid: true},
		DisplayName:   "Alice Example",
		Bio:           "builder",
		AvatarUrl:     "https://example.com/alice.png",
		WalletAddress: pgtype.Text{String: "0x123", Valid: true},
		UserType:      "human",
		IsActive:      true,
		IsAdmin:       true,
		ProhibitLogin: false,
		LastLoginAt:   pgtype.Timestamptz{Time: now, Valid: true},
		CreatedAt:     now.Add(-time.Hour),
		UpdatedAt:     now.Add(time.Hour),
	}

	assert.Equal(t, db.User{
		ID:            99,
		Username:      "alice",
		LowerUsername: "alice",
		Email:         pgtype.Text{String: "alice@example.com", Valid: true},
		LowerEmail:    pgtype.Text{String: "alice@example.com", Valid: true},
		DisplayName:   "Alice Example",
		Bio:           "builder",
		AvatarUrl:     "https://example.com/alice.png",
		WalletAddress: pgtype.Text{String: "0x123", Valid: true},
		UserType:      "human",
		IsActive:      true,
		IsAdmin:       true,
		ProhibitLogin: false,
		LastLoginAt:   pgtype.Timestamptz{Time: now, Valid: true},
		CreatedAt:     now.Add(-time.Hour),
		UpdatedAt:     now.Add(time.Hour),
	}, authRowToUser(row))
}
