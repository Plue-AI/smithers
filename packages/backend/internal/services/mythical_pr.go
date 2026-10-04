package services

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// GitHubRefusal preserves definitive merge refusals for the install envelope.
// The legacy status-only helper cannot retain GitHub's sentence or field errors.
type GitHubRefusal struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Class   string `json:"class"`
	Message string `json:"message"`
	Errors  []struct {
		Message string `json:"message"`
	} `json:"errors,omitempty"`
}

func (e *GitHubRefusal) Error() string { return e.Message }

// These adapter writes are intentionally not mounted: T-GH-09 must journal
// their intent and reconcile ambiguous success before any production caller.
func (g *mythicalGitHubAPI) UpdatePullBody(ctx context.Context, gh mythicalGitHubRepo, number int64, body string) error {
	path := landingGitHubRepoPath(gh.Owner, gh.Name) + "/pulls/" + strconv.FormatInt(number, 10)
	status, err := g.api.request(ctx, gh.Token, http.MethodPatch, path, map[string]string{"body": body}, nil)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "update pull request body")
	}
	return nil
}
func (g *mythicalGitHubAPI) MarkReadyForReview(ctx context.Context, gh mythicalGitHubRepo, nodeID string) error {
	return g.pullDraftMutation(ctx, gh, nodeID, "markPullRequestReadyForReview")
}
func (g *mythicalGitHubAPI) ConvertToDraft(ctx context.Context, gh mythicalGitHubRepo, nodeID string) error {
	return g.pullDraftMutation(ctx, gh, nodeID, "convertPullRequestToDraft")
}
func (g *mythicalGitHubAPI) pullDraftMutation(ctx context.Context, gh mythicalGitHubRepo, nodeID, mutation string) error {
	if nodeID == "" {
		return fmt.Errorf("pull request node identity is required")
	}
	var result struct {
		Data map[string]struct {
			PullRequest *struct {
				ID    string `json:"id"`
				Draft bool   `json:"isDraft"`
			} `json:"pullRequest"`
		} `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	query := "mutation($id: ID!) { " + mutation + "(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }"
	status, err := g.api.request(ctx, gh.Token, http.MethodPost, "/graphql", map[string]any{"query": query, "variables": map[string]string{"id": nodeID}}, &result)
	if err != nil {
		return err
	}
	if status != http.StatusOK {
		return landingGitHubStatusError(status, gh.Owner, gh.Name, "change pull request draft state")
	}
	if len(result.Errors) > 0 {
		return &GitHubRefusal{Status: 422, Code: "github_refused", Class: "github", Message: result.Errors[0].Message, Errors: result.Errors}
	}
	receipt, ok := result.Data[mutation]
	if !ok || receipt.PullRequest == nil || receipt.PullRequest.ID != nodeID || receipt.PullRequest.Draft != (mutation == "convertPullRequestToDraft") {
		return fmt.Errorf("GitHub draft write outcome unknown: missing matching receipt")
	}
	return nil
}

// PR shape consumes accepted dependency facts, never a guessed prefix or the
// live working tree. Existing proposal() renders only an agent's summary.
// This seam remains unmounted until identity, acceptance and authority land.
var mythicalPRSlug = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type mythicalPRShape struct {
	Branch, Title, Prompt, Acceptance, Evidence, DiffStat, Review, URL, Owner string
	First                                                                     bool
	FixesIssue                                                                bool
	DraftsAvailable                                                           bool
	FirstNumber                                                               int64
	Included                                                                  []mythicalPRIncluded
}
type mythicalPRIncluded struct {
	Number int64
	URL    string
}

func (p mythicalPRShape) render() (string, string, error) {
	if !strings.HasPrefix(p.Branch, "smithers/") || !mythicalPRSlug.MatchString(strings.TrimPrefix(p.Branch, "smithers/")) || p.Title == "" || p.Owner == "" {
		return "", "", fmt.Errorf("accepted TODO identity is unavailable")
	}
	var included []string
	for _, item := range p.Included {
		parsed, err := url.Parse(item.URL)
		if item.Number <= 0 || err != nil || parsed.Scheme != "https" || parsed.Host == "" {
			return "", "", fmt.Errorf("accepted included-item link is unavailable")
		}
		included = append(included, fmt.Sprintf("[T%d](%s)", item.Number, item.URL))
	}
	footer := ""
	if len(included) > 0 {
		footer = "\n\nIncludes " + strings.Join(included, ", ") + " until they merge"
	}
	footer += "\n\n" + p.URL + "\n\nRequested by @" + p.Owner
	// Keep identity and the latest prompt; evidence is the truncatable section.
	body := mythicalNoClosingKeywords(p.Prompt + "\n\n" + p.Acceptance)
	evidence := mythicalNoClosingKeywords(p.Evidence + "\n\n" + p.DiffStat + "\n\n" + p.Review)
	budget := 65535 - len(body) - len(footer) - 2
	if budget < 0 {
		return "", "", fmt.Errorf("TODO prompt and manifest exceed GitHub body limit")
	}
	if len(evidence) > budget {
		evidence = evidence[:budget]
		for !utf8.ValidString(evidence) {
			evidence = evidence[:len(evidence)-1]
		}
	}
	return p.Title, body + "\n\n" + evidence + footer, nil
}

// Inbound decisions do not execute effects. The polling owner commits events,
// containment receipts, attention and keyed intents in one transaction.
type mythicalGitHubFact struct {
	Kind, Head, MergeCommit string
	OnMain                  bool
	Number                  int64
	PRNumber                int64
	Manifest                *mythicalMergedManifest
	Earlier                 []mythicalManifestItem
}
type mythicalGitHubFactItem struct {
	State, Head string
	ClosedAt    time.Time
}
type mythicalGitHubFactDecision struct {
	Event, Noop, Attention string
	Contained              []mythicalManifestItem
	Notes                  []string
	AttentionText          string
}

func decideGitHubFact(f mythicalGitHubFact, item mythicalGitHubFactItem, now time.Time) mythicalGitHubFactDecision {
	switch {
	case f.Kind == "merged":
		if item.State == "merged" || item.State == "landed" {
			return mythicalGitHubFactDecision{Noop: "already_merged"}
		}
		if f.MergeCommit == "" || !f.OnMain {
			return mythicalGitHubFactDecision{Noop: "merge_not_on_main"}
		}
		return mythicalContainedDecision(f)
	case item.State == "merged" || item.State == "landed":
		return mythicalGitHubFactDecision{Noop: "terminal"}
	case f.Kind == "closed":
		if item.State == "dropped" || item.State == "rejected" {
			return mythicalGitHubFactDecision{Noop: "already_closed"}
		}
		return mythicalGitHubFactDecision{Event: "dropped"}
	case f.Kind == "reopened":
		if item.State != "dropped" && item.State != "rejected" {
			return mythicalGitHubFactDecision{Noop: "not_dropped"}
		}
		if item.ClosedAt.IsZero() || now.Before(item.ClosedAt) || now.Sub(item.ClosedAt) > 7*24*time.Hour {
			return mythicalGitHubFactDecision{Noop: "reopen_window_expired"}
		}
		return mythicalGitHubFactDecision{Event: "in_review"}
	case f.Kind == "push" && f.Head != "" && f.Head != item.Head:
		if item.State == "dropped" || item.State == "rejected" {
			return mythicalGitHubFactDecision{Noop: "terminal"}
		}
		return mythicalGitHubFactDecision{Attention: "foreign_push"}
	default:
		return mythicalGitHubFactDecision{Noop: "unchanged"}
	}
}

// Required facts come from main's effective protection and rules, including
// required checks that have not produced a run yet. Unknown protection refuses.
type mythicalHeadCheck struct {
	Name     string `json:"name"`
	State    string `json:"state"`
	Required bool   `json:"required"`
}

func (g *mythicalGitHubAPI) HeadCheckFacts(ctx context.Context, gh mythicalGitHubRepo, sha string) ([]mythicalHeadCheck, error) {
	token, err := g.installationToken(ctx, gh, map[string]string{"checks": "read", "statuses": "read", "administration": "read"})
	if err != nil {
		return nil, err
	}
	repo := landingGitHubRepoPath(gh.Owner, gh.Name)
	required := map[string]bool{}
	var protection struct {
		Required struct {
			Contexts []string `json:"contexts"`
			Checks   []struct {
				Context string `json:"context"`
			} `json:"checks"`
		} `json:"required_status_checks"`
	}
	status, err := g.api.request(ctx, token, http.MethodGet, repo+"/branches/main/protection", nil, &protection)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read main protection")
	}
	for _, n := range protection.Required.Contexts {
		required[n] = true
	}
	for _, c := range protection.Required.Checks {
		required[c.Context] = true
	}
	var rules []struct {
		Type       string `json:"type"`
		Parameters struct {
			Checks []struct {
				Context string `json:"context"`
			} `json:"required_status_checks"`
		} `json:"parameters"`
	}
	status, err = g.api.request(ctx, token, http.MethodGet, repo+"/rules/branches/main", nil, &rules)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read main rules")
	}
	for _, rule := range rules {
		if rule.Type == "required_status_checks" {
			for _, c := range rule.Parameters.Checks {
				required[c.Context] = true
			}
		}
	}
	facts := []mythicalHeadCheck{}
	seen := map[string]bool{}
	commit := repo + "/commits/" + url.PathEscape(sha)
	for page := 1; page <= 10; page++ {
		var runs struct {
			Runs []struct {
				Name, Status string
				Conclusion   *string
			} `json:"check_runs"`
		}
		status, err = g.api.request(ctx, token, http.MethodGet, commit+"/check-runs?filter=latest&per_page=100&page="+strconv.Itoa(page), nil, &runs)
		if err != nil {
			return nil, err
		}
		if status != 200 {
			return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read check runs")
		}
		for _, r := range runs.Runs {
			state := mythicalCIPending
			if r.Status == "completed" && r.Conclusion != nil {
				state = mythicalCIRed
				if *r.Conclusion == "success" || *r.Conclusion == "neutral" || *r.Conclusion == "skipped" {
					state = mythicalCIGreen
				}
			}
			facts = append(facts, mythicalHeadCheck{Name: r.Name, State: state, Required: required[r.Name]})
			seen[r.Name] = true
		}
		if len(runs.Runs) < 100 {
			break
		}
		if page == 10 {
			return nil, fmt.Errorf("GitHub check listing is incomplete")
		}
	}
	for page := 1; page <= 10; page++ {
		var statuses []struct{ Context, State string }
		status, err = g.api.request(ctx, token, http.MethodGet, commit+"/statuses?per_page=100&page="+strconv.Itoa(page), nil, &statuses)
		if err != nil {
			return nil, err
		}
		if status != 200 {
			return nil, landingGitHubStatusError(status, gh.Owner, gh.Name, "read commit statuses")
		}
		latest := map[string]bool{}
		for _, r := range statuses {
			// GitHub orders statuses newest first. Keep each context's latest fact.
			key := "status:" + r.Context
			if seen[key] || latest[key] {
				continue
			}
			latest[key] = true
			seen[key] = true
			seen[r.Context] = true
			state := mythicalCIRed
			if r.State == "success" {
				state = mythicalCIGreen
			}
			if r.State == "pending" {
				state = mythicalCIPending
			}
			facts = append(facts, mythicalHeadCheck{Name: r.Context, State: state, Required: required[r.Context]})
		}
		if len(statuses) < 100 {
			break
		}
		if page == 10 {
			return nil, fmt.Errorf("GitHub status listing is incomplete")
		}
	}
	var missing []string
	for name := range required {
		if !seen[name] {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	for _, name := range missing {
		facts = append(facts, mythicalHeadCheck{Name: name, State: mythicalCIPending, Required: true})
	}
	return facts, nil
}

// The production path refuses before token issuance, git transfer or writes
// until the accepted identity/manifest and publication authority are available.
type mythicalPRUnavailable struct{}

// TODOPrUnavailable exposes the shared accepted-facts gate to HTTP readers.
type TODOPrUnavailable = mythicalPRUnavailable

func (*mythicalPRUnavailable) Error() string {
	return "TODO PR publication dependencies are unavailable"
}
func (*mythicalPRUnavailable) MarshalJSON() ([]byte, error) {
	return []byte(`{"code":"dependency_unavailable","class":"infra","message":"TODO PR publication dependencies are unavailable"}`), nil
}

// A retained accepted head and its immutable manifest are supplied by the
// candidate owner. Stack position and head equality without this record prove
// nothing. The caller must fetch the actual merged head before supplying it.
type mythicalManifestItem struct {
	ID     string
	Number int64
	Head   string
	Change string
}
type mythicalMergedManifest struct {
	Head     string
	Included []mythicalManifestItem
}

func mythicalContainedDecision(f mythicalGitHubFact) mythicalGitHubFactDecision {
	d := mythicalGitHubFactDecision{Event: "merged"}
	if len(f.Earlier) == 0 {
		return d
	}
	d.Attention = "order"
	var sentences []string
	for _, earlier := range f.Earlier {
		contained := false
		if f.Head != "" && f.Manifest != nil && f.Manifest.Head == f.Head {
			for _, included := range f.Manifest.Included {
				if earlier.ID != "" && earlier.Head != "" && earlier.Change != "" && included.ID == earlier.ID && included.Head == earlier.Head && included.Change == earlier.Change {
					contained = true
					break
				}
			}
		}
		if contained {
			note := fmt.Sprintf("T%d merged before T%d; T%d's change is in T%d's commit", f.Number, earlier.Number, earlier.Number, f.Number)
			d.Contained = append(d.Contained, earlier)
			d.Notes = append(d.Notes, note)
			sentences = append(sentences, note)
		} else {
			sentences = append(sentences, fmt.Sprintf("T%d merged out of order; containment of T%d is unverified", f.Number, earlier.Number))
		}
	}
	d.AttentionText = strings.Join(sentences, "\n")
	return d
}
