package services

import (
	"context"
	"encoding/json"
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
// outsider's text and its edit leaves no maintainer text.
func nativePersonActor(ctx context.Context, actorID int64) pgtype.Int8 {
	if middleware.AuthInfoFromContext(ctx).IsRunCredential() {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: actorID, Valid: actorID > 0}
}

// nativeIssueTextEditor is the person a native issue write names as the
// writer of its title and body (record_issue_text_editor): nativePersonActor,
// so a run credential's edit names no one.
func nativeIssueTextEditor(ctx context.Context, actorID int64) string {
	if person := nativePersonActor(ctx, actorID); person.Valid {
		return strconv.FormatInt(person.Int64, 10)
	}
	return ""
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

// approvesIssueText is the single rule for whether an issue event approves
// the issue's current text for credentialed work started by trigger. A
// maintainer's text is approved as written. Other text (an outsider's, or a
// maintainer's issue someone else edited) is approved only by this event: a
// maintainer person applying the trigger label, while the label is on the
// issue. An app (including the repository's own agent), a read or triage
// user, and an outsider author's own label approve nothing, and neither does
// any other label, assignee or milestone change.
func approvesIssueText(textByMaintainer bool, labels []string, applied gitHubLabelApplication, trigger string) bool {
	if textByMaintainer {
		return true
	}
	trigger = strings.TrimSpace(trigger)
	return trigger != "" && strings.EqualFold(strings.TrimSpace(applied.Label), trigger) &&
		applied.ByMaintainer && issueCarriesLabel(labels, trigger)
}

// authoredText is the part of an event's issue, pull request, comment or
// review object the trust rule reads.
type authoredText struct {
	TextByMaintainer bool `json:"smithers_text_by_maintainer"`
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
func gitHubIssueEventApproves(eventType, action string, payload []byte, trigger string) bool {
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
	return approvesIssueText(event.Issue.TextByMaintainer, issueLabelNames(event.Issue.Labels), applied, trigger)
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
