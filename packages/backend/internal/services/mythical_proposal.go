package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Proposals: assigning an issue to the Smithers account, or a maintainer's
// comment that @mentions it, asks for the issue to become a TODO. The stack
// records the proposal on the issue's item, visibly, with the comment's text
// as context; it never authorizes coding and registers no repository job.
// Coding starts only when a maintainer person applies todo (ObserveIssue),
// after which the lane reads the proposal's comment as the maintainer's.

// smithersAccount is the login assignments and mentions name; its GitHub
// App account is smithersAccount+"[bot]".
const smithersAccount = "smithers"

const (
	// mythicalWaitingForTodo is an issue's reason until it is a TODO, and
	// mythicalProposedBy prefixes it while a proposal stands.
	mythicalWaitingForTodo = "waiting for a maintainer to add the todo label"
	mythicalProposedBy     = "proposed by "
	// mythicalProposalContextBytes bounds the comment kept as context, and
	// mythicalMentionMemory how many proposing comment texts an item recalls.
	mythicalProposalContextBytes = 4 << 10
	mythicalMentionMemory        = 32
)

// mythicalProposal is the latest request that an issue become a TODO: an
// assignment to the Smithers account, or a maintainer's @mention.
type mythicalProposal struct {
	Via     string    `json:"via"` // "assignment" | "mention"
	By      string    `json:"by"`
	Context string    `json:"context,omitempty"`
	At      time.Time `json:"at"`
}

// mythicalProposalReason is an item's reason given its proposal: only the
// reason of an issue waiting for todo names who proposed it.
func mythicalProposalReason(reason string, checks mythicalChecks) string {
	if reason != mythicalWaitingForTodo && !strings.HasPrefix(reason, mythicalProposedBy) {
		return reason
	}
	if checks.Proposal == nil {
		return mythicalWaitingForTodo
	}
	return mythicalProposedBy + checks.Proposal.By + "; " + mythicalWaitingForTodo
}

// namesSmithers reports whether login is the Smithers account or its App.
func namesSmithers(login string) bool {
	login = strings.ToLower(strings.TrimSpace(login))
	return login == smithersAccount || login == smithersAccount+"[bot]"
}

// mythicalGitHubSource is the repository an event names.
type mythicalGitHubSource struct {
	Name  string `json:"name"`
	Owner struct {
		Login string `json:"login"`
	} `json:"owner"`
}

// observeAssignment records a maintainer's assignment of the issue to the
// Smithers account as a proposal, and withdraws an assignment's proposal
// that has not become a TODO when the account is unassigned.
func (s *MythicalService) observeAssignment(ctx context.Context, repositoryID int64, policy factoryGitHubPolicy, action string, sender gitHubActor, payload []byte, issue mythicalIssue) error {
	action = strings.ToLower(strings.TrimSpace(action))
	if action != "assigned" && action != "unassigned" {
		return nil
	}
	var event struct {
		Assignee *gitHubActor `json:"assignee"`
	}
	if json.Unmarshal(payload, &event) != nil || event.Assignee == nil || !namesSmithers(event.Assignee.Login) ||
		issue.PullRequest || !strings.EqualFold(issue.State, "open") {
		return nil
	}
	if action == "unassigned" {
		return s.changeProposal(ctx, repositoryID, issue.Number, func(checks *mythicalChecks) bool {
			if checks.Proposal == nil || checks.Proposal.Via != "assignment" {
				return false
			}
			checks.Proposal = nil
			return true
		})
	}
	maintainer, err := s.proposer(ctx, repositoryID, policy, sender)
	if err != nil || !maintainer {
		return err
	}
	proposal := mythicalProposal{Via: "assignment", By: sender.Login, At: time.Now().UTC()}
	return s.changeProposal(ctx, repositoryID, issue.Number, func(checks *mythicalChecks) bool {
		checks.Proposal = &proposal
		return true
	})
}

// observeMention records a maintainer's new comment that @mentions the
// Smithers account outside code as a proposal, once per comment text: the
// same text posted again, or its delivery replayed, proposes nothing new.
func (s *MythicalService) observeMention(ctx context.Context, payload []byte) error {
	var event struct {
		Action  string               `json:"action"`
		Issue   *mythicalGitHubIssue `json:"issue"`
		Comment *struct {
			Body   string           `json:"body"`
			User   gitHubActor      `json:"user"`
			ViaApp *json.RawMessage `json:"performed_via_github_app"`
		} `json:"comment"`
		Repository *mythicalGitHubSource `json:"repository"`
	}
	if json.Unmarshal(payload, &event) != nil || !strings.EqualFold(strings.TrimSpace(event.Action), "created") ||
		event.Issue == nil || event.Comment == nil || event.Repository == nil {
		return nil
	}
	issue, comment := event.Issue.issue(), event.Comment
	viaApp := comment.ViaApp != nil && string(*comment.ViaApp) != "null"
	if issue.PullRequest || !strings.EqualFold(issue.State, "open") || viaApp || strings.EqualFold(comment.User.Type, "Bot") ||
		!slices.Contains(ExtractMentions(comment.Body), smithersAccount) {
		return nil
	}
	text := strings.TrimSpace(comment.Body)
	sum := sha256.Sum256([]byte(text))
	digest := hex.EncodeToString(sum[:])
	if len(text) > mythicalProposalContextBytes {
		text = text[:mythicalProposalContextBytes]
	}
	ids, err := s.queries().ListRepositoryIDsForGitHubSource(ctx, event.Repository.Owner.Login, event.Repository.Name)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := s.queries().GetMythicalStack(ctx, id); errors.Is(err, pgx.ErrNoRows) {
			continue
		} else if err != nil {
			return err
		}
		policy, err := s.stackPolicy(ctx, id)
		if err != nil {
			return err
		}
		maintainer, err := s.proposer(ctx, id, policy, comment.User)
		if err != nil {
			return err
		}
		if !maintainer {
			continue
		}
		proposal := mythicalProposal{Via: "mention", By: comment.User.Login, Context: text, At: time.Now().UTC()}
		if err := s.changeProposal(ctx, id, issue.Number, func(checks *mythicalChecks) bool {
			if slices.Contains(checks.Mentions, digest) {
				return false
			}
			checks.Mentions = append(checks.Mentions, digest)
			if len(checks.Mentions) > mythicalMentionMemory {
				checks.Mentions = checks.Mentions[len(checks.Mentions)-mythicalMentionMemory:]
			}
			checks.Proposal = &proposal
			return true
		}); err != nil {
			return err
		}
	}
	return nil
}

// proposer reports whether account may propose work: a person the owner's
// policy names as a maintainer who has write access to the repository.
func (s *MythicalService) proposer(ctx context.Context, repositoryID int64, policy factoryGitHubPolicy, account gitHubActor) (bool, error) {
	if s.github == nil || strings.EqualFold(account.Type, "Bot") || !policy.maintains(account.Login) {
		return false, nil
	}
	gh, err := s.stackGitHub(ctx, repositoryID)
	if err != nil {
		return false, err
	}
	return s.github.Maintainer(ctx, gh, account)
}

// changeProposal applies change to the proposal of an issue that is not a
// TODO yet, and shows it in a waiting item's reason. A TODO needs no
// proposal: change is not asked. An issue the stack has not observed yet is
// an error, so the delivery is retried after the issue event or sweep.
func (s *MythicalService) changeProposal(ctx context.Context, repositoryID, number int64, change func(*mythicalChecks) bool) error {
	q := s.queries()
	stack, err := q.GetMythicalStack(ctx, repositoryID)
	if err != nil {
		return err
	}
	for range 3 {
		item, err := q.GetMythicalItemByIssue(ctx, repositoryID, number)
		if errors.Is(err, pgx.ErrNoRows) {
			return errors.New("the issue is not observed yet; the delivery is retried")
		}
		if err != nil {
			return err
		}
		checks := mythicalChecksOf(item)
		if checks.Todo || checks.AutoTodo != "" || !change(&checks) {
			return nil
		}
		item.Checks = checks.encode()
		if item.State == "skipped" {
			item.Reason = mythicalProposalReason(item.Reason, checks)
		}
		saved, err := q.SaveMythicalItem(ctx, item)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		s.itemChanged(ctx, q, stack, saved.ID)
		return nil
	}
	return errors.New("the item changed concurrently; the delivery is retried")
}
