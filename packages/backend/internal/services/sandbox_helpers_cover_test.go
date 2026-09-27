package services

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

func TestSandboxHelpers_Cov_TokenErrorsAndPushScope(t *testing.T) {
	if _, err := issueTemporaryRepoToken(context.Background(), nil, 1, "name", "scope"); err == nil || !strings.Contains(err.Error(), "store unavailable") {
		t.Fatalf("nil store err = %v", err)
	}

	store := sandboxHelperTokenStore{createFn: func(context.Context, db.CreateAccessTokenParams) (db.AccessToken, error) {
		return db.AccessToken{}, errors.New("insert failed")
	}}
	if _, err := issueTemporarySyncPushToken(context.Background(), store, 5, 9, "push"); err == nil || !strings.Contains(err.Error(), "insert failed") {
		t.Fatalf("create err = %v", err)
	}

	var scopes string
	store = sandboxHelperTokenStore{createFn: func(_ context.Context, arg db.CreateAccessTokenParams) (db.AccessToken, error) {
		scopes = arg.Scopes
		return db.AccessToken{ID: 12}, nil
	}}
	token, err := issueTemporarySyncPushToken(context.Background(), store, 5, 9, "push")
	if err != nil || token.ID != 12 || scopes != "write:repository,repo:9,credential:sync" {
		t.Fatalf("token=%+v scopes=%q err=%v", token, scopes, err)
	}
}

func TestSandboxHelpers_Cov_BuildRepoCloneURLBasePathAndUserStripping(t *testing.T) {
	parsed, err := buildRepoCloneURL("https://user:pass@git.example.test/api/", "Alice", "Demo")
	if err != nil {
		t.Fatalf("buildRepoCloneURL returned error: %v", err)
	}
	if parsed.User != nil || parsed.String() != "https://git.example.test/api/Alice/Demo.git" {
		t.Fatalf("parsed url = %s user=%v", parsed.String(), parsed.User)
	}

	if _, err := buildAuthenticatedRepoCloneURL("https://git.example.test", "alice", "demo", " "); err == nil {
		t.Fatal("expected missing token error")
	}
}
