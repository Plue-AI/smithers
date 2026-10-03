package services

import (
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// The typed reason a TODO failed (#2783): which step failed (its kind) and
// whose fault it was, read from the item's typed fault and state only. Its
// sentence is built from those types, never from an error's text, so every
// surface (the app, the TUI, the CLI and the API) shows the same words and
// none shows a raw internal error.

// The steps a TODO fails at.
const (
	// mythicalFailProvisioning: a lane or its run could not be set up.
	mythicalFailProvisioning = "provisioning"
	// mythicalFailRuntime: the run failed on Smithers' runtime or a service
	// it depends on other than a model provider.
	mythicalFailRuntime = "runtime"
	// mythicalFailModel: the model provider failed or rate limited the run.
	mythicalFailModel = "model"
	// mythicalFailChecks: the repository's checks or its pull request's CI
	// failed on the result.
	mythicalFailChecks = "checks"
	// mythicalFailPlan: the attempt produced no working change.
	mythicalFailPlan = "plan"
	// mythicalFailLanding: the pull request could not be opened, followed or
	// merged, or it closed without merging.
	mythicalFailLanding = "landing"
	// mythicalFailReview: the review of the pull request's head did not finish.
	mythicalFailReview = "review"
	// mythicalFailStopped: a person, a bound or a defect stopped it.
	mythicalFailStopped = "stopped"
)

// MythicalFailureView is why an item failed: its kind (the step) and fault
// (the failure registry's class: whose fault it was). The item's reason is
// the sentence for them.
type MythicalFailureView struct {
	Kind  string `json:"kind"`
	Fault string `json:"fault"`
}

// mythicalOutcomeFault types a failed run's outcome (mythicalFailedOutcome)
// at a step whose own failure is failed (plan or checks).
func mythicalOutcomeFault(failed, outcome string) mythicalFault {
	switch {
	case outcome == mythicalCancelled:
		return mythicalFault{Class: "user", Tag: "cancelled", Kind: mythicalFailStopped}
	case strings.HasPrefix(outcome, mythicalStopped):
		class, tag, _ := strings.Cut(strings.TrimPrefix(outcome, mythicalStopped), ": ")
		return mythicalFault{Class: class, Tag: tag, Kind: mythicalFailStopped}
	case strings.HasPrefix(outcome, mythicalOutage):
		class, tag, _ := strings.Cut(strings.TrimPrefix(outcome, mythicalOutage), ": ")
		return mythicalFault{Class: class, Tag: tag, Kind: mythicalOutageKind(class, tag)}
	}
	return mythicalFault{Class: "factory", Tag: strings.TrimPrefix(outcome, "failed: "), Kind: failed}
}

// mythicalOutageKind is the step an outage failed: a model provider's (a
// wait or dependency fault of a model error) or the runtime's.
func mythicalOutageKind(class, tag string) string {
	if (class == "wait" || class == "dependency") && strings.Contains(tag, "/model/") {
		return mythicalFailModel
	}
	return mythicalFailRuntime
}

// kind is the fault's step; a fault recorded before kinds were is read
// from its class and tag.
func (f mythicalFault) kind() string {
	switch {
	case f.Kind != "":
		return f.Kind
	case f.Tag == "launch":
		return mythicalFailProvisioning
	case f.Tag == "github":
		return mythicalFailLanding
	case f.Class == "factory":
		return mythicalFailPlan
	case f.Class == "user" || f.Class == "bug" || f.Class == "policy" && f.Tag != "outages":
		return mythicalFailStopped
	}
	return mythicalOutageKind(f.Class, f.Tag)
}

// fault is whose fault the failure was: an outage past its bound stays the
// fault of what failed, not the bound's.
func (f mythicalFault) fault() string {
	if f.Class != "policy" || f.Tag != "outages" {
		return f.Class
	}
	if f.kind() == mythicalFailModel {
		return "dependency"
	}
	return "infra"
}

// sentence is the fault in a person's words.
func (f mythicalFault) sentence() string {
	var sentence string
	switch f.kind() {
	case mythicalFailProvisioning:
		sentence = "Smithers could not set up a lane"
	case mythicalFailRuntime:
		sentence = "Smithers could not run this attempt"
	case mythicalFailModel:
		sentence = "The model provider did not answer"
	case mythicalFailChecks:
		switch f.Tag {
		case "ci":
			sentence = "CI failed on the pull request"
		case "ci_wait":
			sentence = "CI on the pull request did not finish"
		default:
			sentence = "Checks failed"
		}
	case mythicalFailLanding:
		sentence = "GitHub did not answer"
		if f.Tag == "merge" {
			sentence = "GitHub refused the merge"
		}
	case mythicalFailPlan:
		sentence = "This attempt did not produce a working change"
		if f.Tag == "very_hard" {
			sentence = "Every plan failed"
		}
	default:
		switch {
		case f.Tag == "cancelled":
			sentence = "The run was cancelled"
		case f.Tag == "launch_bound":
			sentence = "It reached its run limit"
		case f.Tag == "protected_paths":
			sentence = "It changes protected paths"
		case f.Tag == "placement":
			sentence = "No machine matches what this repository declares"
		case f.Class == "bug":
			sentence = "Smithers hit a defect"
		case f.Class == "user":
			sentence = "The run was stopped"
		default:
			sentence = "A repository policy stopped it"
		}
	}
	if f.Class == "policy" && f.Tag == "outages" {
		sentence += " after repeated tries"
	}
	return sentence
}

// mythicalFailureOf is the item's typed failure and its sentence, or nil
// while it has none: a stop or a retry after a typed fault, a pull request
// closed without merging, or a review a person may retry.
func mythicalFailureOf(item db.MythicalItem) (*MythicalFailureView, string) {
	switch item.State {
	case "rejected":
		return &MythicalFailureView{Kind: mythicalFailLanding, Fault: "user"}, "The pull request closed without merging"
	case "landed", "cancelled", "declined", "skipped":
		return nil, ""
	}
	if item.Source != "chat" && mythicalReviewHeld(item) {
		return &MythicalFailureView{Kind: mythicalFailReview, Fault: mythicalReviewFault(item)}, "The review did not finish"
	}
	fault := mythicalChecksOf(item).Fault
	if fault == nil {
		return nil, ""
	}
	return &MythicalFailureView{Kind: fault.kind(), Fault: fault.fault()}, fault.sentence()
}

// mythicalSentence starts an authored reason as a sentence.
func mythicalSentence(reason string) string {
	if reason == "" {
		return ""
	}
	first, size := utf8.DecodeRuneInString(reason)
	return string(unicode.ToUpper(first)) + reason[size:]
}

// mythicalReviewFault is whose fault a held review was, by its verdict: a
// person's cancel, a stop's own class, the review's failure (factory), or
// the outages it could not run through (infra).
func mythicalReviewFault(item db.MythicalItem) string {
	review := mythicalChecksOf(item).Review
	switch {
	case review == nil || review.Head != item.PRHead:
		return "infra"
	case review.Verdict == mythicalCancelled:
		return "user"
	case strings.HasPrefix(review.Verdict, mythicalStopped):
		class, _, _ := strings.Cut(strings.TrimPrefix(review.Verdict, mythicalStopped), ": ")
		return class
	case strings.HasPrefix(review.Verdict, mythicalOutage):
		class, _, _ := strings.Cut(strings.TrimPrefix(review.Verdict, mythicalOutage), ": ")
		return class
	case strings.HasPrefix(review.Verdict, "failed"):
		return "factory"
	}
	return "infra"
}

// mythicalDiagnostic reports whether a stored reason is a failure's
// diagnostic, which only its typed sentence stands for on any surface.
func mythicalDiagnostic(reason string) bool {
	return strings.Contains(reason, mythicalOutage)
}
