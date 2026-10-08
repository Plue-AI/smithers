package compose

import (
	"encoding/json"
	"errors"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"net/url"
	"strings"
)

// Adapt the ordinary review flow's committed result to the retained change
// card. Walkthrough HTML and model thinking are not shared chat frames.
func reviewChange(a services.ReviewAdmission, output string) (json.RawMessage, error) {
	var result struct {
		Review struct {
			Status   string `json:"status"`
			OK       bool   `json:"ok"`
			Comments []struct {
				Path       string `json:"path"`
				Content    string `json:"content"`
				StartLine  int    `json:"startLine"`
				Severity   string `json:"severity"`
				Suggestion string `json:"suggestionCode"`
			} `json:"comments"`
		} `json:"review"`
	}
	if len(output) > 4*1024*1024 || json.Unmarshal([]byte(output), &result) != nil || !result.Review.OK || result.Review.Status != "success" {
		return nil, errors.New("review did not complete")
	}
	u, err := url.Parse(a.URL)
	if err != nil {
		return nil, err
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 4 || parts[2] != "pull" {
		return nil, errors.New("invalid review PR URL")
	}
	findings := []map[string]any{}
	for _, c := range result.Review.Comments {
		if c.Path == "" || c.Content == "" || c.StartLine <= 0 {
			return nil, errors.New("unanchored review finding")
		}
		severity := "fix"
		switch c.Severity {
		case "critical", "major", "minor":
		case "info":
			severity = "info"
		default:
			return nil, errors.New("invalid review severity")
		}
		findings = append(findings, map[string]any{"analyzer": "review", "severity": severity, "path": c.Path, "line": c.StartLine, "summary": c.Content, "suggestion": c.Suggestion, "raisedAtSeq": nil, "commitId": a.Head})
	}
	return json.Marshal(map[string]any{"repo": parts[0] + "/" + parts[1], "changeId": a.Head, "description": "Review", "pullRequest": map[string]any{"number": a.Number, "url": a.URL}, "commitId": a.Head, "currentSeq": nil, "revisionCount": nil, "revisions": []any{}, "authorName": nil, "timestamp": nil, "repos": []any{}, "diff": nil, "checks": nil, "findings": findings, "reviews": nil, "threads": nil, "conflicts": nil, "stack": nil, "changeset": nil, "facet": "findings"})
}
