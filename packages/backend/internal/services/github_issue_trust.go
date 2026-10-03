package services

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

// issueApprovalLabel is the trigger label a maintainer applies to an
// outsider's issue to approve its current text for credentialed work. A job
// that configures its own label uses that label instead.
const issueApprovalLabel = "smithers"

// Issue, pull request, comment and review text is an instruction channel
// into an agent that holds the repository's credentials, and no model-side
// screen is a security boundary. Automatic work therefore starts only from
// text whose author and last writers are maintainers (GitHubTextStamper and
// the native event payloads decide it once, at ingress), or from outsider
// text a maintainer approved with the trigger label. A maintainer can still
// run the work by hand.

// labelAppliedByMaintainerField is the field of a labeled event's label that
// says whether a maintainer person applied it (GitHubTextStamper, native
// label payloads); a label without it fails closed.
const labelAppliedByMaintainerField = "smithers_applied_by_maintainer"

// gitHubLabelApplication is the label one "labeled" event applied and
// whether a maintainer person applied it. The zero value is any other event,
// or a sweep.
type gitHubLabelApplication struct {
	Label        string
	ByMaintainer bool
	// AutoTodo, when set, is why the factory makes this issue a TODO without
	// the label under the owner's committed policy (mythicalAutoTodo).
	AutoTodo string
	// By is the login of the account that applied the label, or that
	// removed it when Removed.
	By      string
	Removed bool
	// EventID is the live labeled event this application is, once the stack
	// read the label as it stands (0 when it did not).
	EventID int64
}

// gitHubLabelApplied reads the label application from a stamped issue event.
func gitHubLabelApplied(action string, payload []byte) gitHubLabelApplication {
	if !strings.EqualFold(strings.TrimSpace(action), "labeled") {
		return gitHubLabelApplication{}
	}
	var event struct {
		Label *struct {
			Name         string `json:"name"`
			ByMaintainer bool   `json:"smithers_applied_by_maintainer"`
		} `json:"label"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Label == nil {
		return gitHubLabelApplication{}
	}
	return gitHubLabelApplication{Label: event.Label.Name, ByMaintainer: event.Label.ByMaintainer}
}

// nativePersonActor is the person a native write names: the sender of a
// label application, the writer of an issue's title and body. A person acting
// through their own session or token is named. A system-issued run credential
// acts as the user who owns the run, but the run's agent is not that person:
// like a GitHub App on GitHub it names no one, so its label approves no
// outsider's text and its edit leaves no maintainer text. An agent account's
// own credential names no one either.
func nativePersonActor(ctx context.Context, actorID int64) pgtype.Int8 {
	if middleware.AuthInfoFromContext(ctx).IsAgent() {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: actorID, Valid: actorID > 0}
}

// nativeIssueTextWriter is who a native issue write names as the writer of
// its title and body (record_issue_text_editor): the acting account
// (nativePersonActor), or, for a run credential, no account and the "run"
// agent source, so the issue it files or the text it writes never counts as
// a maintainer's.
func nativeIssueTextWriter(ctx context.Context, actorID int64) (editor, source string) {
	if person := nativePersonActor(ctx, actorID); person.Valid {
		return strconv.FormatInt(person.Int64, 10), ""
	}
	if middleware.AuthInfoFromContext(ctx).IsRunCredential() {
		return "", "run"
	}
	return "", ""
}

type gitHubActor struct {
	ID    int64  `json:"id"`
	Login string `json:"login"`
	Type  string `json:"type"`
}

type gitHubLabel struct {
	Name string `json:"name"`
}

func issueLabelNames(labels []gitHubLabel) []string {
	names := make([]string, 0, len(labels))
	for _, label := range labels {
		names = append(names, label.Name)
	}
	return names
}

func issueCarriesLabel(labels []string, label string) bool {
	label = strings.TrimSpace(label)
	if label == "" {
		return false
	}
	for _, name := range labels {
		if strings.EqualFold(strings.TrimSpace(name), label) {
			return true
		}
	}
	return false
}

// issueTextByMaintainerField is the field of an event's issue, pull
// request, comment or review object that says whether its text is a
// maintainer's own: its author and the last writer of every part (a title, a
// body) are maintainer persons. GitHub names the author's association, not
// the writer's standing, so the webhook worker (GitHubTextStamper) and the
// native event payloads set it; an object without it fails closed.
const issueTextByMaintainerField = "smithers_text_by_maintainer"

// issueText is what the ingress stamps say about an issue's current text:
// whether it is a maintainer's own (issueTextByMaintainerField), and the
// agent source that filed and wrote all of it (authoredText.TextSource).
type issueText struct {
	ByMaintainer bool
	Source       string
}

// approvesIssueText is the single rule for whether an issue event approves
// the issue's current text for credentialed work started by trigger. A
// maintainer's text is approved as written, and so is text an agent source
// filed and wrote when allowedSources (the default bookmark's owner-committed
// agentIssueSources) names that source. Other text (an outsider's, an
// agent's, or a maintainer's issue someone else edited) is approved only by
// this event: a maintainer person applying the trigger label, while the
// label is on the issue. An app or agent (including the repository's own
// agent), a read or triage user, and an outsider author's own label approve
// nothing, and neither does any other label, assignee or milestone change.
func approvesIssueText(text issueText, allowedSources []string, labels []string, applied gitHubLabelApplication, trigger string) bool {
	if text.ByMaintainer || (text.Source != "" && slices.Contains(allowedSources, text.Source)) {
		return true
	}
	trigger = strings.TrimSpace(trigger)
	return trigger != "" && strings.EqualFold(strings.TrimSpace(applied.Label), trigger) &&
		applied.ByMaintainer && issueCarriesLabel(labels, trigger)
}

// authoredText is the part of an event's issue, pull request, comment or
// review object the trust rule reads. TextSource is the native stamp naming
// the agent source ("run", "linear", "trial") that filed an issue and wrote
// all its current text; absent for anything else (0060).
type authoredText struct {
	TextByMaintainer bool   `json:"smithers_text_by_maintainer"`
	TextSource       string `json:"smithers_text_source"`
}

func (a *authoredText) maintainers() bool {
	return a != nil && a.TextByMaintainer
}

// eventIssue is the part of an event's issue object the trust rule reads.
type eventIssue struct {
	authoredText
	Labels []gitHubLabel `json:"labels"`
}

// gitHubIssueEventApproves applies approvesIssueText to one event. A comment
// adds its own text, so it must be a maintainer's too, and it never
// approves outsider issue text. Events that carry no issue text pass.
// allowedSources is the repository's agentIssueSources.
func gitHubIssueEventApproves(eventType, action string, payload []byte, trigger string, allowedSources []string) bool {
	kind := NormalizeTriggerName(eventType)
	if kind != "issue" && kind != "issue_comment" {
		return true
	}
	var event struct {
		Issue   *eventIssue   `json:"issue"`
		Comment *authoredText `json:"comment"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Issue == nil {
		return false
	}
	applied := gitHubLabelApplied(action, payload)
	if kind == "issue_comment" {
		if !event.Comment.maintainers() {
			return false
		}
		applied = gitHubLabelApplication{}
	}
	return approvesIssueText(issueText{ByMaintainer: event.Issue.TextByMaintainer, Source: event.Issue.TextSource},
		allowedSources, issueLabelNames(event.Issue.Labels), applied, trigger)
}

// gitHubEventByOutsider reports whether an event carries text that is not a
// maintainer's own: an issue approved by a label, or a pull request, comment
// or review. Work it starts never changes a protected path.
func gitHubEventByOutsider(payload []byte) bool {
	var event struct {
		Issue       *authoredText `json:"issue"`
		PullRequest *authoredText `json:"pull_request"`
		Comment     *authoredText `json:"comment"`
		Review      *authoredText `json:"review"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return true
	}
	for _, part := range []*authoredText{event.Issue, event.PullRequest, event.Comment, event.Review} {
		if part != nil && !part.maintainers() {
			return true
		}
	}
	return false
}
