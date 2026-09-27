package services

import (
	"encoding/json"
	"strings"
)

// issueApprovalLabel is the trigger label a maintainer applies to an
// outsider's issue to approve its current text for credentialed work. A job
// that configures its own label uses that label instead.
const issueApprovalLabel = "smithers"

// Issue and comment text is an instruction channel into an agent that holds
// the repository's credentials, and no model-side screen is a security
// boundary. Automatic work therefore starts only when the event's author is a
// repository OWNER, MEMBER or COLLABORATOR (the gate the review Action uses).
// NONE, CONTRIBUTOR, FIRST_TIMER, FIRST_TIME_CONTRIBUTOR, MANNEQUIN and a
// missing value start nothing; a maintainer can still run the work by hand.
func trustedGitHubAuthorAssociation(association string) bool {
	switch strings.ToUpper(strings.TrimSpace(association)) {
	case "OWNER", "MEMBER", "COLLABORATOR":
		return true
	}
	return false
}

// gitHubLabelApplication is the label one "labeled" event applied and who
// applied it. The zero value is any other event, or a sweep.
type gitHubLabelApplication struct {
	Label      string
	SenderType string
	// ByAuthor is an application by the issue's own author, such as an issue
	// form's template labels.
	ByAuthor bool
}

// gitHubLabelApplied reads the label application from a signed issue event.
func gitHubLabelApplied(action string, payload []byte) gitHubLabelApplication {
	if !strings.EqualFold(strings.TrimSpace(action), "labeled") {
		return gitHubLabelApplication{}
	}
	var event struct {
		Label *struct {
			Name string `json:"name"`
		} `json:"label"`
		Sender *gitHubActor `json:"sender"`
		Issue  *struct {
			User *gitHubActor `json:"user"`
		} `json:"issue"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Label == nil || event.Sender == nil || event.Issue == nil || event.Issue.User == nil {
		return gitHubLabelApplication{}
	}
	author, sender := event.Issue.User, event.Sender
	byAuthor := sender.ID == 0 || author.ID == 0 || sender.ID == author.ID ||
		strings.EqualFold(strings.TrimSpace(sender.Login), strings.TrimSpace(author.Login))
	return gitHubLabelApplication{Label: event.Label.Name, SenderType: sender.Type, ByAuthor: byAuthor}
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

// approvesIssueText is the single rule for whether an issue event approves
// the issue's current text for credentialed work started by trigger. A
// trusted author's text is approved as written. An outsider's text is
// approved only by this event applying the trigger label, while the label is
// on the issue. GitHub lets only people with triage access change labels, but
// an issue form applies its template labels as the author, and an app
// (including the repository's own agent) is not a maintainer, so the
// application must come from a user other than the author. Any other label,
// assignee or milestone change approves nothing.
func approvesIssueText(authorAssociation string, labels []string, applied gitHubLabelApplication, trigger string) bool {
	if trustedGitHubAuthorAssociation(authorAssociation) {
		return true
	}
	trigger = strings.TrimSpace(trigger)
	return trigger != "" && strings.EqualFold(strings.TrimSpace(applied.Label), trigger) &&
		applied.SenderType == "User" && !applied.ByAuthor && issueCarriesLabel(labels, trigger)
}

// gitHubIssueEventApproves applies approvesIssueText to one signed event. A
// comment adds its own text, so its author must be trusted too, and it never
// approves an outsider's issue text. Events that carry no issue text pass.
func gitHubIssueEventApproves(eventType, action string, payload []byte, trigger string) bool {
	kind := NormalizeTriggerName(eventType)
	if kind != "issue" && kind != "issue_comment" {
		return true
	}
	var event struct {
		Issue *struct {
			AuthorAssociation string        `json:"author_association"`
			Labels            []gitHubLabel `json:"labels"`
		} `json:"issue"`
		Comment *struct {
			AuthorAssociation string `json:"author_association"`
		} `json:"comment"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Issue == nil {
		return false
	}
	applied := gitHubLabelApplied(action, payload)
	if kind == "issue_comment" {
		if event.Comment == nil || !trustedGitHubAuthorAssociation(event.Comment.AuthorAssociation) {
			return false
		}
		applied = gitHubLabelApplication{}
	}
	return approvesIssueText(event.Issue.AuthorAssociation, issueLabelNames(event.Issue.Labels), applied, trigger)
}

// gitHubEventByOutsider reports whether a signed event carries text from an
// author who is not a maintainer: an issue approved by a label, a pull
// request, comment or review. Work it starts never changes a protected path.
func gitHubEventByOutsider(payload []byte) bool {
	type authored struct {
		AuthorAssociation string `json:"author_association"`
	}
	var event struct {
		Issue       *authored `json:"issue"`
		PullRequest *authored `json:"pull_request"`
		Comment     *authored `json:"comment"`
		Review      *authored `json:"review"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return true
	}
	for _, part := range []*authored{event.Issue, event.PullRequest, event.Comment, event.Review} {
		if part != nil && !trustedGitHubAuthorAssociation(part.AuthorAssociation) {
			return true
		}
	}
	return false
}
