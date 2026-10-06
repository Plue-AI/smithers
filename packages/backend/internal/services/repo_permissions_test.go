package services

import (
	"context"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"net/http"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNormalizeRepoPermission(t *testing.T) {
	t.Parallel()

	tests := []struct {
		input    string
		expected string
	}{
		{"admin", "admin"},
		{"ADMIN", "admin"},
		{"  write  ", "write"},
		{"Read", "read"},
		{"", ""},
		{"unknown", "unknown"},
	}

	for _, tt := range tests {
		result := normalizeRepoPermission(tt.input)
		assert.Equal(t, tt.expected, result, "input: %q", tt.input)
	}
}

func TestRepoPermissionRank(t *testing.T) {
	t.Parallel()

	tests := []struct {
		permission string
		expected   int
	}{
		{"admin", 3},
		{"write", 2},
		{"read", 1},
		{"", 0},
		{"unknown", 0},
		{"ADMIN", 3},
		{"  write  ", 2},
	}

	for _, tt := range tests {
		rank := repoPermissionRank(tt.permission)
		assert.Equal(t, tt.expected, rank, "permission: %q", tt.permission)
	}
}

func TestHighestRepoPermission_SingleValue(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "admin", highestRepoPermission("admin"))
	assert.Equal(t, "write", highestRepoPermission("write"))
	assert.Equal(t, "read", highestRepoPermission("read"))
	assert.Equal(t, "", highestRepoPermission(""))
}

func TestHighestRepoPermission_MultipleValues(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "admin", highestRepoPermission("read", "admin"))
	assert.Equal(t, "write", highestRepoPermission("read", "write"))
	assert.Equal(t, "admin", highestRepoPermission("write", "admin", "read"))
	assert.Equal(t, "read", highestRepoPermission("", "read", ""))
}

func TestHighestRepoPermission_EmptyList(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "", highestRepoPermission())
}

func TestHighestRepoPermission_AllEmpty(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "", highestRepoPermission("", "", ""))
}

func TestHighestRepoPermission_MixedCase(t *testing.T) {
	t.Parallel()

	assert.Equal(t, "admin", highestRepoPermission("READ", "Admin", "write"))
}

func TestBoundInstallAuthorization(t *testing.T) {
	info := &middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "session"}
	ctx := middleware.ContextWithAuthInfo(context.Background(), info)
	decision := InstallAuthorization{UserID: 7, Role: InstallMember}
	ctx = WithInstallAuthorization(ctx, "todo.read", decision)
	got, err := Authorize(ctx, nil, "todo.read")
	assert.NoError(t, err)
	assert.Equal(t, decision, got)
	// A dispatcher must not reuse read authority for another command.
	_, err = Authorize(ctx, nil, "secrets.write")
	assert.Error(t, err)
	// A replacement credential for the same person gets a fresh decision.
	replacement := &middleware.AuthInfo{User: &db.User{ID: 7}, SessionHash: "replacement"}
	_, err = Authorize(middleware.ContextWithAuthInfo(ctx, replacement), nil, "todo.read")
	assert.Error(t, err)
	// Changing principal also prevents decision reuse.
	_, err = Authorize(middleware.ContextWithAuthInfo(ctx, &middleware.AuthInfo{User: &db.User{ID: 8}}), nil, "todo.read")
	assert.Error(t, err)
	_, err = Authorize(ctx, nil, "unmapped")
	var refusal *AccessError
	assert.ErrorAs(t, err, &refusal)
	assert.Equal(t, http.StatusForbidden, refusal.Status)
}
