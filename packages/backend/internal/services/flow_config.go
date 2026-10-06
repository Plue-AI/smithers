package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
	workspaceapi "github.com/smithersai/smithers/packages/backend/workspace"
)

const InstallCodingProjectKey = "coding.project"

// PersistInstallCodingProject consumes the image detector's evidence at pinned
// main. It reads data only and never writes generated defaults to the repository.
func PersistInstallCodingProject(ctx context.Context, pool *pgxpool.Pool, sources workspaceapi.SourceFiles, source workspaceapi.WorkspaceSource, paths []string) error {
	recipe, err := microsandbox.DetectRecipe(func(name string) ([]byte, bool, error) {
		data, err := sources.ReadSourceFile(ctx, source, name)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, false, nil
		}
		return data, err == nil, err
	})
	if err != nil {
		return err
	}
	checks := []map[string]any{}
	detected := []map[string]any{}
	for _, command := range recipe.Checks {
		tier := "fast"
		if command.ID == "test" {
			tier = "slow"
		}
		checks = append(checks, map[string]any{"id": command.ID, "target": ".", "flow": "checks/" + command.ID, "tier": tier, "required": true})
		detected = append(detected, map[string]any{"flow": "checks/" + command.ID, "argv": command.Argv, "timeoutMs": 1800000})
	}
	// No guessed command can pass as a build. The guest refuses this declaration
	// with check_configuration until the owner supplies an executable build.
	if len(checks) == 0 {
		checks = append(checks, map[string]any{"id": "build-only", "target": ".", "flow": "checks/build-only", "tier": "fast", "required": true})
		detected = append(detected, map[string]any{"flow": "checks/build-only", "argv": []string{}, "timeoutMs": 1800000})
	}
	sort.Strings(paths)
	packages := map[string]bool{}
	for _, name := range paths {
		if strings.HasPrefix(name, ".") || strings.Contains(name, "/.") {
			continue
		}
		if dir, _, ok := strings.Cut(name, "/"); ok {
			packages[dir] = true
		}
	}
	pages := []map[string]any{}
	page := func(id, title string) {
		pages = append(pages, map[string]any{"id": id, "title": title, "purpose": "Describe the code with source citations", "kind": "current", "document": "", "sourceDirectory": ".", "inputs": []string{}, "related": []string{}})
	}
	page("overview", "Overview")
	page("architecture", "Architecture")
	dirs := []string{}
	for dir := range packages {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	used := map[string]bool{}
	for _, dir := range dirs {
		if len(pages) >= 10 {
			break
		}
		id := "package-" + strings.ToLower(dir)
		if !mythicalWikiPageID.MatchString(id) || used[id] {
			digest := sha256.Sum256([]byte(dir))
			prefix := regexp.MustCompile(`[^a-z0-9-]`).ReplaceAllString(strings.ToLower(dir), "-")
			if len(prefix) > 50 {
				prefix = prefix[:50]
			}
			id = "package-" + prefix + "-" + hex.EncodeToString(digest[:4])
		}
		used[id] = true
		page(id, dir)
		pages[len(pages)-1]["sourceDirectory"] = dir
	}
	seats := map[string]string{}
	for _, role := range []string{"coding/implement", "coding/plan", "coding/poc", "coding/review", "wiki/reviewer", "coding/dispatch", "repository/research", "repository/evaluator", "repository/author", "flow/author"} {
		seats[role] = "auto"
	}
	config := map[string]any{"conflictAttempts": 1, "implementation": "coding/implementation", "checks": checks, "detected": detected, "wiki": len(pages) > 0, "seats": seats}
	if len(pages) > 0 {
		config["pages"] = pages
		config["wikiOutput"] = "/var/tmp/smithers/wiki"
		config["reviewer"] = "product-engineering-v1"
	}
	raw, err := json.Marshal(config)
	if err != nil {
		return err
	}
	// A retried setup never overwrites owner changes. All defaults are one row.
	_, err = pool.Exec(ctx, `INSERT INTO install_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`, InstallCodingProjectKey, raw)
	return err
}

// MergeCodingProject replaces repository fields; seats merge by role. Config
// data remains validated by the canonical guest loader, including unknown keys.
func MergeCodingProject(stored, repository []byte) ([]byte, error) {
	var defaults, overlay map[string]json.RawMessage
	if json.Unmarshal(stored, &defaults) != nil || defaults == nil {
		return nil, fmt.Errorf("invalid install coding configuration")
	}
	if repository != nil {
		if json.Unmarshal(repository, &overlay) != nil || overlay == nil {
			return nil, fmt.Errorf("invalid .smithers/coding-project.json")
		}
		for key, value := range overlay {
			if key == "seats" {
				var base, roles map[string]json.RawMessage
				if json.Unmarshal(defaults[key], &base) != nil || json.Unmarshal(value, &roles) != nil || roles == nil {
					return nil, fmt.Errorf("invalid .smithers/coding-project.json seats")
				}
				if base == nil {
					base = map[string]json.RawMessage{}
				}
				for role, seat := range roles {
					base[role] = seat
				}
				value, _ = json.Marshal(base)
			}
			defaults[key] = value
		}
		// Repository checks name their own registered bodies. Stored command bodies
		// must not replace a repository's explicitly declared flows.
		if _, ok := overlay["checks"]; ok && overlay["detected"] == nil {
			delete(defaults, "detected")
		}
	}
	return json.Marshal(defaults)
}

func StoredCodingProject(ctx context.Context, q *db.Queries) ([]byte, error) {
	row, err := q.GetInstallSetting(ctx, InstallCodingProjectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("install coding configuration is not ready")
	}
	return row.Value, err
}
