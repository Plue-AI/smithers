package services

import (
	"context"
	"errors"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/webhook"
)

// C-MCH-12 step 3: a path inside the working copy, one that leaves the home,
// one through a symlink and one outside the files root are each refused with
// class `user` when declared.
func TestSecretPathRefusalsAreUserClass(t *testing.T) {
	for _, tc := range []struct{ path, code string }{
		{"/workspace/.env", "path_working_copy"},
		{"/workspace", "path_working_copy"},
		{"~/../x", "path_escapes_home"},
		{"~/.config/../../x", "path_escapes_home"},
		{"/run/smithers/files/../../etc/x", "path_escapes_home"},
		{"~/.cargo/credentials.toml", "path_symlink"},
		{"~/.cache/pnpm/token", "path_symlink"},
		{"~/.local/share/pnpm/store", "path_symlink"},
		{"/etc/x", "path_not_allowed"},
		{"/run/smithers/env", "path_not_allowed"},
		{"/home/ben/.npmrc", "path_not_allowed"},
		{".npmrc", "path_invalid"},
		{"~ben/.npmrc", "path_invalid"},
		{"~/", "path_invalid"},
		{"~//x", "path_invalid"},
		{"~/a/./b", "path_invalid"},
		{"~/dir/", "path_invalid"},
		{"~/a b", "path_invalid"},
		{"~/a\x00b", "path_invalid"},
		{"~/key;rm", "path_invalid"},
		{"/run/smithers/files/", "path_invalid"},
		{"~/" + strings.Repeat("a/", maxSecretPathParts) + "x", "path_invalid"},
		{"~/" + strings.Repeat("a", maxSecretPathElement+1), "path_invalid"},
		{"~/" + strings.Repeat("abcdefgh/", 60), "path_invalid"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			_, err := NormalizeSecretPath(tc.path)
			var refusal *AccessError
			require.ErrorAs(t, err, &refusal)
			require.Equal(t, "user", refusal.Class)
			require.Equal(t, tc.code, refusal.Code)
			require.Equal(t, 400, refusal.Status)
		})
	}
}

func TestSecretPathAcceptsHomeAndFilesRoot(t *testing.T) {
	for raw, want := range map[string]string{
		"":                                    "",
		"   ":                                 "",
		"~/.config/anthropic/key":             "~/.config/anthropic/key",
		" ~/.npmrc ":                          "~/.npmrc",
		"~/.cargo-not-a-link":                 "~/.cargo-not-a-link",
		"~/.cachex/pnpm":                      "~/.cachex/pnpm",
		"/run/smithers/files/npm/token":       "/run/smithers/files/npm/token",
		"~/a@b+c=d_e-f.g":                     "~/a@b+c=d_e-f.g",
		"/run/smithers/files/.netrc":          "/run/smithers/files/.netrc",
		"~/" + strings.Repeat("a/", 15) + "x": "~/" + strings.Repeat("a/", 15) + "x",
	} {
		got, err := NormalizeSecretPath(raw)
		require.NoError(t, err, raw)
		require.Equal(t, want, got, raw)
	}
}

// The declared-path check mirrors the links the guest helper plants; drift
// would let a declared path reach a link the broker then refuses silently.
func TestSecretHomeLinksMatchGuestHelper(t *testing.T) {
	source, err := os.ReadFile("../../microsandbox/guest/smithers-guest.py")
	require.NoError(t, err)
	block := regexp.MustCompile(`(?s)HOME_LINKS = \{(.*?)\n\}`).FindSubmatch(source)
	require.NotNil(t, block)
	var guest []string
	for _, match := range regexp.MustCompile(`:\s*"([^"]+)"`).FindAllSubmatch(block[1], -1) {
		guest = append(guest, string(match[1]))
	}
	slices.Sort(guest)
	ours := slices.Clone(secretHomeLinks)
	slices.Sort(ours)
	require.Equal(t, guest, ours)
}

func TestSetSecretStoresKeepsAndClearsPath(t *testing.T) {
	ctx := context.Background()
	var params []db.CreateOrUpdateSecretParams
	q := &mockSecretQuerier{createOrUpdateFn: func(_ context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
		params = append(params, arg)
		return db.RepositorySecret{Name: arg.Name, Path: arg.Path.String}, nil
	}}
	svc := NewSecretService(q, webhook.NoopSecretCodec{})
	actor := &db.User{ID: 1}
	declared := " ~/.config/anthropic/key "
	response, err := svc.SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_API_KEY", "sk-ant-api03-x", nil, nil, &declared)
	require.NoError(t, err)
	require.Equal(t, "~/.config/anthropic/key", response.Path)
	_, err = svc.SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_API_KEY", "sk-ant-api03-y", nil, nil, nil)
	require.NoError(t, err)
	cleared := ""
	_, err = svc.SetSecret(ctx, actor, "alice", "demo", "ANTHROPIC_API_KEY", "sk-ant-api03-z", nil, nil, &cleared)
	require.NoError(t, err)
	require.Len(t, params, 3)
	require.True(t, params[0].Path.Valid)
	require.Equal(t, "~/.config/anthropic/key", params[0].Path.String)
	require.False(t, params[1].Path.Valid, "an omitted path keeps the stored one")
	require.True(t, params[2].Path.Valid)
	require.Equal(t, "", params[2].Path.String)
}

func TestSetSecretRefusesBadPathBeforeAnyWrite(t *testing.T) {
	wrote := false
	q := &mockSecretQuerier{createOrUpdateFn: func(context.Context, db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
		wrote = true
		return db.RepositorySecret{}, nil
	}}
	bad := "~/../x"
	_, err := NewSecretService(q, webhook.NoopSecretCodec{}).SetSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", "TOKEN", "v", nil, nil, &bad)
	var refusal *AccessError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "user", refusal.Class)
	require.False(t, wrote)
}

func TestSetSecretRefusesPathAnotherSecretHolds(t *testing.T) {
	path := "~/.npmrc"
	rows := []db.ListSecretsRow{{Name: "NPM_TOKEN", Path: path}, {Name: "OTHER"}}
	wrote := 0
	q := &mockSecretQuerier{
		listSecretsFn: func(context.Context, int64) ([]db.ListSecretsRow, error) { return rows, nil },
		createOrUpdateFn: func(_ context.Context, arg db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
			wrote++
			return db.RepositorySecret{Name: arg.Name, Path: arg.Path.String}, nil
		},
	}
	svc := NewSecretService(q, webhook.NoopSecretCodec{})
	_, err := svc.SetSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", "OTHER", "v", nil, nil, &path)
	var refusal *AccessError
	require.ErrorAs(t, err, &refusal)
	require.Equal(t, "path_taken", refusal.Code)
	require.Equal(t, "user", refusal.Class)
	require.Zero(t, wrote)
	// The holder itself may replace its value at the same path.
	_, err = svc.SetSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", "NPM_TOKEN", "v2", nil, nil, &path)
	require.NoError(t, err)
	require.Equal(t, 1, wrote)
	// A writer that raced the pre-check meets the unique index.
	q.listSecretsFn = func(context.Context, int64) ([]db.ListSecretsRow, error) { return nil, nil }
	q.createOrUpdateFn = func(context.Context, db.CreateOrUpdateSecretParams) (db.RepositorySecret, error) {
		return db.RepositorySecret{}, &pgconn.PgError{Code: "23505", ConstraintName: "repository_secrets_repo_path"}
	}
	_, err = svc.SetSecret(context.Background(), &db.User{ID: 1}, "alice", "demo", "RACER", "v", nil, nil, &path)
	require.True(t, errors.As(err, &refusal))
	require.Equal(t, "path_taken", refusal.Code)
}

// A declared file holds an unbound secret's value and a bound secret's
// placeholder, never a bound value; a main-only secret has no file on a
// branch machine (spec §8.8.1a, §8.8.1b, §8.8.2).
func TestRepositorySecretFilesHoldValuesOrPlaceholders(t *testing.T) {
	q := &mockSecretInjectionQuerier{listSecretValuesFn: func(context.Context, int64) ([]db.ListSecretValuesRow, error) {
		return []db.ListSecretValuesRow{
			{Name: "NPM_TOKEN", ValueEncrypted: []byte("npm-literal"), Path: "~/.npmrc"},
			{Name: "ANTHROPIC_API_KEY", ValueEncrypted: []byte("sk-ant-api03-real"), Hosts: []string{"api.anthropic.com"}, MatchHeaders: []string{"x-api-key"}, Path: "~/.config/anthropic/key"},
			{Name: "DEPLOY_KEY", ValueEncrypted: []byte("main-sentinel"), MainOnly: true, Path: "/run/smithers/files/deploy"},
			{Name: "PLAIN", ValueEncrypted: []byte("plain")},
		}, nil
	}}
	snapshot, err := NewSecretInjector(q, webhook.NoopSecretCodec{}).RepositorySecrets(context.Background(), 7, false)
	require.NoError(t, err)
	require.Equal(t, map[string]string{"~/.npmrc": "npm-literal", "~/.config/anthropic/key": "ANTHROPIC_API_KEY"}, snapshot.Files)
	require.NotContains(t, snapshot.Env, "ANTHROPIC_API_KEY")
	require.Len(t, snapshot.Bound, 1)
	trusted, err := NewSecretInjector(q, webhook.NoopSecretCodec{}).RepositorySecrets(context.Background(), 7, true)
	require.NoError(t, err)
	require.Equal(t, "main-sentinel", trusted.Files["/run/smithers/files/deploy"])
}
