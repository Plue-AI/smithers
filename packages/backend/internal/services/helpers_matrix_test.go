package services

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

func TestValidateCreateTokenName_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		input       string
		wantName    string
		wantStatus  int
		wantMessage string
		wantField   string
		wantCode    string
	}{
		{
			name:     "trimmed_name",
			input:    "  laptop token  ",
			wantName: "laptop token",
		},
		{
			name:        "empty_name",
			input:       " ",
			wantStatus:  422,
			wantMessage: "validation failed",
			wantField:   "name",
			wantCode:    "missing_field",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			name, err := validateCreateTokenName(tc.input)
			if tc.wantStatus != 0 {
				require.NotNil(t, err)
				assert.Equal(t, tc.wantStatus, err.Status)
				assert.Equal(t, tc.wantMessage, err.Message)
				require.Len(t, err.Errors, 1)
				assert.Equal(t, tc.wantField, err.Errors[0].Field)
				assert.Equal(t, tc.wantCode, err.Errors[0].Code)
				assert.Empty(t, name)
				return
			}

			require.Nil(t, err)
			assert.Equal(t, tc.wantName, name)
		})
	}
}

func TestNormalizeAndValidateRequestedScopes_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		input         []string
		want          []string
		wantFields    []string
		wantFieldCode string
	}{
		{
			name:          "missing_scopes",
			input:         nil,
			wantFields:    []string{"scopes"},
			wantFieldCode: "missing_field",
		},
		{
			name: "single_scope",
			input: []string{
				"read:repository",
			},
			want: []string{"read:repository"},
		},
		{
			name: "canonicalizes_dedupes_and_sorts",
			input: []string{
				" write:user ",
				"READ:REPOSITORY",
				"user",
				"repository",
				"write:user",
			},
			want: []string{"read:repository", "write:repository", "write:user"},
		},
		{
			name: "multiple_invalid_indices",
			input: []string{
				"read:repository",
				"bogus",
				" ",
				"write:user",
				"delete:everything",
			},
			wantFields:    []string{"scopes[1]", "scopes[2]", "scopes[4]"},
			wantFieldCode: "invalid",
		},
		{
			name: "blank_entries_are_invalid_even_with_valid_scopes",
			input: []string{
				"read:user",
				"",
			},
			wantFields:    []string{"scopes[1]"},
			wantFieldCode: "invalid",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeAndValidateRequestedScopes(tc.input)
			if len(tc.wantFields) > 0 {
				require.NotNil(t, err)
				assert.Equal(t, 422, err.Status)
				assert.Equal(t, "validation failed", err.Message)
				require.Len(t, err.Errors, len(tc.wantFields))
				for i, field := range tc.wantFields {
					assert.Equal(t, field, err.Errors[i].Field)
					assert.Equal(t, tc.wantFieldCode, err.Errors[i].Code)
				}
				assert.Nil(t, got)
				return
			}

			require.Nil(t, err)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestContainsPrivilegedScope_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input []string
		want  bool
	}{
		{name: "empty", input: nil, want: false},
		{name: "read_only", input: []string{"read:repository"}, want: false},
		{name: "write_only", input: []string{"write:repository"}, want: false},
		{name: "admin", input: []string{"admin"}, want: true},
		{name: "admin_read", input: []string{"read:admin"}, want: true},
		{name: "admin_write", input: []string{"write:admin"}, want: true},
		{name: "read_admin", input: []string{"read:admin"}, want: true},
		{name: "write_admin", input: []string{"write:admin"}, want: true},
		{name: "all", input: []string{"all"}, want: true},
		{name: "mixed_with_admin", input: []string{"read:user", "admin"}, want: true},
		{name: "mixed_with_admin_read", input: []string{"read:user", "read:admin"}, want: true},
		{name: "mixed_with_all", input: []string{"read:user", "all"}, want: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, containsPrivilegedScope(tc.input))
		})
	}
}

func TestHighestRepoPermission_ExhaustiveMatrix(t *testing.T) {
	t.Parallel()

	values := []string{
		"",
		"read",
		"WRITE",
		" admin ",
		"unknown",
		" READ ",
	}

	expectedHighest := func(inputs ...string) string {
		best := ""
		bestRank := -1
		for _, input := range inputs {
			normalized := strings.ToLower(strings.TrimSpace(input))
			rank := map[string]int{
				"admin": 3,
				"write": 2,
				"read":  1,
			}[normalized]
			if rank > bestRank {
				bestRank = rank
				best = normalized
			}
		}
		if bestRank <= 0 {
			return ""
		}
		return best
	}

	caseID := 0
	runCase := func(inputs ...string) {
		inputsCopy := append([]string(nil), inputs...)
		name := fmt.Sprintf("case_%03d", caseID)
		caseID++
		t.Run(name, func(t *testing.T) {
			assert.Equal(t, expectedHighest(inputsCopy...), highestRepoPermission(inputsCopy...))
		})
	}

	runCase()
	for _, a := range values {
		runCase(a)
	}
	for _, a := range values {
		for _, b := range values {
			runCase(a, b)
		}
	}
	for _, a := range values {
		for _, b := range values {
			for _, c := range values {
				runCase(a, b, c)
			}
		}
	}

	assert.Equal(t, 259, caseID)
}

func TestNormalizeRepoPermission_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  string
	}{
		{input: "", want: ""},
		{input: " read ", want: "read"},
		{input: "WRITE", want: "write"},
		{input: " Admin ", want: "admin"},
		{input: "unknown", want: "unknown"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(fmt.Sprintf("normalize_%q", tc.input), func(t *testing.T) {
			assert.Equal(t, tc.want, normalizeRepoPermission(tc.input))
		})
	}
}

func TestRepoPermissionRank_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input string
		want  int
	}{
		{input: "", want: 0},
		{input: "read", want: 1},
		{input: " write ", want: 2},
		{input: "ADMIN", want: 3},
		{input: "unknown", want: 0},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(fmt.Sprintf("rank_%q", tc.input), func(t *testing.T) {
			assert.Equal(t, tc.want, repoPermissionRank(tc.input))
		})
	}
}

func TestRequireScopeForMode_Matrix(t *testing.T) {
	t.Parallel()

	scopeSets := []struct {
		name   string
		scopes middleware.ScopeSet
	}{
		{name: "nil", scopes: nil},
		{name: "read", scopes: middleware.ParseTokenScopes("read:repository")},
		{name: "write", scopes: middleware.ParseTokenScopes("write:repository")},
		{name: "admin", scopes: middleware.ParseTokenScopes("admin")},
		{name: "all", scopes: middleware.ParseTokenScopes("all")},
		{name: "user_only", scopes: middleware.ParseTokenScopes("read:user")},
	}

	modes := []struct {
		name string
		mode AccessMode
	}{
		{name: "read", mode: AccessModeRead},
		{name: "write", mode: AccessModeWrite},
		{name: "invalid", mode: AccessMode("delete")},
	}

	for _, scopeSet := range scopeSets {
		scopeSet := scopeSet
		for _, mode := range modes {
			mode := mode
			t.Run(scopeSet.name+"_"+mode.name, func(t *testing.T) {
				err := requireScopeForMode(scopeSet.scopes, mode.mode)
				switch mode.mode {
				case AccessModeRead:
					if scopeSet.scopes != nil && scopeSet.scopes.Has(middleware.ScopeReadRepository) {
						require.NoError(t, err)
					} else {
						requireAPIError(t, err, 403, "insufficient token scope")
					}
				case AccessModeWrite:
					if scopeSet.scopes != nil && scopeSet.scopes.Has(middleware.ScopeWriteRepository) {
						require.NoError(t, err)
					} else {
						requireAPIError(t, err, 403, "insufficient token scope")
					}
				default:
					requireAPIError(t, err, 400, "unsupported access mode")
				}
			})
		}
	}
}

func TestAccessModeFromInfoRefsService_Matrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		input       string
		want        AccessMode
		wantStatus  int
		wantMessage string
	}{
		{name: "upload_pack", input: "git-upload-pack", want: AccessModeRead},
		{name: "receive_pack", input: "git-receive-pack", want: AccessModeWrite},
		{name: "trimmed_receive_pack", input: " git-receive-pack ", want: AccessModeWrite},
		{name: "unsupported", input: "git-delete-pack", wantStatus: 400, wantMessage: "unsupported git service"},
		{name: "empty", input: "", wantStatus: 400, wantMessage: "unsupported git service"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			mode, err := accessModeFromInfoRefsService(tc.input)
			if tc.wantStatus != 0 {
				requireAPIError(t, err, tc.wantStatus, tc.wantMessage)
				assert.Empty(t, mode)
				return
			}
			require.NoError(t, err)
			assert.Equal(t, tc.want, mode)
		})
	}
}

func TestUserID_NilAndValue(t *testing.T) {
	t.Parallel()

	assert.Equal(t, int64(0), userID(nil))
	assert.Equal(t, int64(42), userID(&db.User{ID: 42}))
}

func requireAPIError(t *testing.T, err error, wantStatus int, wantMessage string) {
	t.Helper()

	require.Error(t, err)
	apiErr, ok := err.(*pkgerrors.APIError)
	require.True(t, ok, "expected *APIError, got %T", err)
	assert.Equal(t, wantStatus, apiErr.Status)
	assert.Equal(t, wantMessage, apiErr.Message)
}

func ptrInt64(v int64) *int64 {
	return &v
}
