package config

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"
)

// WikiSyncConfig lists trusted host folders reconciled with wiki scopes. It is
// a hosted deployment port only; Mac installs use authorized install settings.
type WikiSyncConfig struct {
	// IntervalSeconds between passes, at most one day. Zero selects one minute.
	IntervalSeconds int                    `mapstructure:"interval_seconds"`
	Obsidian        []WikiFolderSyncConfig `mapstructure:"obsidian"`
}

// WikiFolderSyncConfig binds one Obsidian folder to a repository wiki scope.
// Login names the account whose write access every pass requires.
type WikiFolderSyncConfig struct {
	Owner      string `mapstructure:"owner"`
	Repo       string `mapstructure:"repo"`
	Login      string `mapstructure:"login"`
	Visibility string `mapstructure:"visibility"`
	Connection string `mapstructure:"connection"`
	Folder     string `mapstructure:"folder"`
}

// Interval is the wait between folder sync passes.
func (c WikiSyncConfig) Interval() time.Duration {
	if c.IntervalSeconds == 0 {
		return time.Minute
	}
	return time.Duration(c.IntervalSeconds) * time.Second
}

func validateWikiSync(cfg *Config) error {
	sync := cfg.WikiSync
	if sync.IntervalSeconds < 0 || sync.IntervalSeconds > 86400 {
		return fmt.Errorf("wiki_sync.interval_seconds must be between 0 and 86400")
	}
	if len(sync.Obsidian) > 0 && !cfg.FeatureFlags.Wiki {
		return fmt.Errorf("wiki_sync.obsidian requires feature_flags.wiki")
	}
	seen, folders := map[string]bool{}, map[string]bool{}
	for i, f := range sync.Obsidian {
		field := fmt.Sprintf("wiki_sync.obsidian[%d]", i)
		if f.Owner == "" || f.Repo == "" || f.Login == "" || f.Connection == "" || len(f.Connection) > 128 {
			return fmt.Errorf("%s requires owner, repo, login and a connection of at most 128 bytes", field)
		}
		if f.Visibility != "public" && f.Visibility != "private" {
			return fmt.Errorf("%s.visibility must be public or private", field)
		}
		if !filepath.IsAbs(f.Folder) {
			return fmt.Errorf("%s.folder must be an absolute path", field)
		}
		key := strings.ToLower(f.Owner + "/" + f.Repo + "/" + f.Visibility + "/" + f.Connection)
		if seen[key] {
			return fmt.Errorf("%s repeats a connection for that repository and visibility", field)
		}
		seen[key] = true
		folder := filepath.Clean(f.Folder)
		if folders[folder] {
			return fmt.Errorf("%s.folder is already synced by another entry", field)
		}
		folders[folder] = true
	}
	return nil
}
