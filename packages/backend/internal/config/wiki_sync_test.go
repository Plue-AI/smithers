package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func loadWikiSyncConfig(t *testing.T, body string) (*Config, error) {
	t.Helper()
	clearConfigEnv(t)
	file := filepath.Join(t.TempDir(), "config.yaml")
	require.NoError(t, os.WriteFile(file, []byte(body), 0o600))
	return Load(file)
}

func TestLoad_WikiSyncFolders(t *testing.T) {
	cfg, err := loadWikiSyncConfig(t, `
feature_flags:
  wiki: true
wiki_sync:
  obsidian:
    - {owner: acme, repo: notes, login: alice, visibility: private, connection: vault, folder: /srv/vault}
    - {owner: acme, repo: notes, login: alice, visibility: public, connection: vault, folder: /srv/public}
`)
	require.NoError(t, err)
	require.Equal(t, time.Minute, cfg.WikiSync.Interval(), "the default pass interval is one minute")
	require.Equal(t, []WikiFolderSyncConfig{
		{Owner: "acme", Repo: "notes", Login: "alice", Visibility: "private", Connection: "vault", Folder: "/srv/vault"},
		{Owner: "acme", Repo: "notes", Login: "alice", Visibility: "public", Connection: "vault", Folder: "/srv/public"},
	}, cfg.WikiSync.Obsidian)

	cfg, err = loadWikiSyncConfig(t, "wiki_sync:\n  interval_seconds: 86400\n")
	require.NoError(t, err)
	require.Equal(t, 24*time.Hour, cfg.WikiSync.Interval())
	require.Empty(t, cfg.WikiSync.Obsidian)
}

func TestLoad_WikiSyncFoldersRefused(t *testing.T) {
	entry := func(fields string) string {
		return "feature_flags:\n  wiki: true\nwiki_sync:\n  obsidian:\n    - {" + fields + "}\n"
	}
	for name, c := range map[string]struct{ want, body string }{
		"wiki disabled":     {"requires feature_flags.wiki", "wiki_sync:\n  obsidian:\n    - {owner: a, repo: r, login: u, visibility: private, connection: c, folder: /v}\n"},
		"missing owner":     {"requires owner", entry("repo: r, login: u, visibility: private, connection: c, folder: /v")},
		"missing repo":      {"requires owner", entry("owner: a, login: u, visibility: private, connection: c, folder: /v")},
		"missing login":     {"requires owner", entry("owner: a, repo: r, visibility: private, connection: c, folder: /v")},
		"missing conn":      {"requires owner", entry("owner: a, repo: r, login: u, visibility: private, folder: /v")},
		"long conn":         {"requires owner", entry("owner: a, repo: r, login: u, visibility: private, folder: /v, connection: " + strings.Repeat("c", 129))},
		"bad visibility":    {"visibility must be", entry("owner: a, repo: r, login: u, visibility: internal, connection: c, folder: /v")},
		"no visibility":     {"visibility must be", entry("owner: a, repo: r, login: u, connection: c, folder: /v")},
		"relative folder":   {"must be an absolute path", entry("owner: a, repo: r, login: u, visibility: private, connection: c, folder: vault")},
		"negative interval": {"between 0 and 86400", "wiki_sync:\n  interval_seconds: -1\n"},
		"huge interval":     {"between 0 and 86400", "wiki_sync:\n  interval_seconds: 9223372037\n"},
		"shared folder": {"already synced", "feature_flags:\n  wiki: true\nwiki_sync:\n  obsidian:\n" +
			"    - {owner: a, repo: r, login: u, visibility: private, connection: c, folder: /v}\n" +
			"    - {owner: a, repo: s, login: u, visibility: private, connection: c, folder: /v/}\n"},
		"duplicate": {"repeats a connection", "feature_flags:\n  wiki: true\nwiki_sync:\n  obsidian:\n" +
			"    - {owner: a, repo: r, login: u, visibility: private, connection: c, folder: /v}\n" +
			"    - {owner: A, repo: R, login: u, visibility: private, connection: c, folder: /w}\n"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := loadWikiSyncConfig(t, c.body)
			require.ErrorContains(t, err, "wiki_sync")
			require.ErrorContains(t, err, c.want)
		})
	}
}
