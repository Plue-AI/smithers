package services

import (
	"context"
	"path"
	"strings"
	"unicode/utf8"

	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

type wikiScopeKey struct{}

// WithWikiVisibility selects one independent wiki. Authorization is still
// checked by every service entry point; a context value grants no access.
func WithWikiVisibility(ctx context.Context, visibility string) (context.Context, error) {
	if visibility == "" {
		visibility = "public"
	}
	if visibility != "public" && visibility != "private" {
		return nil, pkgerrors.BadRequest("visibility must be public or private")
	}
	return context.WithValue(ctx, wikiScopeKey{}, visibility), nil
}
func wikiVisibility(ctx context.Context) string {
	if value, ok := ctx.Value(wikiScopeKey{}).(string); ok {
		return value
	}
	return "public"
}

func isWikiMarkdownPath(value string) bool {
	return strings.HasSuffix(strings.ToLower(value), ".md")
}

func normalizeWikiPath(value, slug string) (string, error) {
	if value == "" {
		value = slug + ".md"
	}
	if len(value) > 1024 || !utf8.ValidString(value) || strings.ContainsAny(value, "\\\x00\r\n") || strings.HasPrefix(value, "/") || path.Clean(value) != value || !isWikiMarkdownPath(value) {
		return "", pkgerrors.BadRequest("path must be a relative Markdown filename")
	}
	for _, part := range strings.Split(value, "/") {
		if part == "." || part == ".." || strings.TrimSpace(part) == "" {
			return "", pkgerrors.BadRequest("invalid wiki path")
		}
	}
	return value, nil
}
