package services

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// MythicalLandInput is a maintainer's press of Land on a proposed TODO:
// Head is the pull request head they saw, so a head that moved since is
// refused instead of landed unseen.
type MythicalLandInput struct {
	Head string `json:"head"`
}

// mythicalLand is a maintainer person's request, made through Smithers, that
// the stack merge a TODO's pull request at one head: the automerge label the
// App applies for them is theirs while this names the head the stack merges.
type mythicalLand struct {
	By      string `json:"by"`
	Account int64  `json:"account"`
	Head    string `json:"head"`
}

var mythicalHead = regexp.MustCompile(`^[0-9a-f]{40}$`)

// LandTodo asks the stack to merge a proposed TODO's pull request for a
// maintainer person. It never merges: it applies the automerge label, the
// same authorization a maintainer's own label on GitHub is, and the stack
// merges only as it does for that label, at the reviewed head once its
// review approves and GitHub CI on it is green. The person's linked GitHub
// account is read as it stands now, named by
// the policy (or no one) and a maintainer on GitHub. The App applies the
// label, so GitHub names the App; the stack counts it only for the head
// recorded here, and re-reads the person when it merges.
func (s *MythicalService) LandTodo(ctx context.Context, repositoryID, userID int64, itemID string, input MythicalLandInput) (MythicalItemView, error) {
	if err := middleware.RequirePerson(ctx, "land a TODO"); err != nil {
		return MythicalItemView{}, err
	}
	id, err := uuid.Parse(itemID)
	if err != nil {
		return MythicalItemView{}, pkgerrors.BadRequest("invalid item id")
	}
	if !mythicalHead.MatchString(input.Head) {
		return MythicalItemView{}, pkgerrors.ValidationFailed(pkgerrors.FieldError{Resource: "Land", Field: "head", Code: "invalid"})
	}
	if s.github == nil {
		return MythicalItemView{}, pkgerrors.Internal("GitHub is not configured for the mythical stack")
	}
	q := s.queries()
	item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && item.RepositoryID != repositoryID) {
		return MythicalItemView{}, pkgerrors.NotFound("item not found")
	}
	if err != nil {
		return MythicalItemView{}, err
	}
	if err := mythicalLandable(item, input.Head); err != nil {
		return MythicalItemView{}, err
	}
	gh, account, err := s.maintainerPerson(ctx, repositoryID, userID, "land a TODO")
	if err != nil {
		return MythicalItemView{}, err
	}
	// The label first: its event, whenever it arrives, finds the item as
	// it was, and the record below keeps automerge on while it stays.
	if err := s.github.AddLabel(ctx, gh, item.IssueNumber.Int64, automergeLabel); err != nil {
		return MythicalItemView{}, err
	}
	for range 3 {
		item, err := q.GetMythicalItem(ctx, pgtype.UUID{Bytes: id, Valid: true})
		if err != nil {
			return MythicalItemView{}, err
		}
		if err := mythicalLandable(item, input.Head); err != nil {
			return MythicalItemView{}, err
		}
		next := item
		checks := mythicalChecksOf(next)
		checks.Automerge = true
		checks.Land = &mythicalLand{By: account.Login, Account: account.ID, Head: item.PRHead}
		next.Checks = checks.encode()
		// The gate runs on the next pass, not the next poll.
		next.NextAttemptAt = pgtype.Timestamptz{}
		saved, err := s.saveItem(ctx, next)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return MythicalItemView{}, err
		}
		if stack, err := q.GetMythicalStack(ctx, repositoryID); err == nil {
			s.itemChanged(ctx, q, stack, saved.ID)
		}
		return s.itemView(ctx, saved)
	}
	return MythicalItemView{}, pkgerrors.Conflict("the item kept changing; try again")
}

// mythicalLandable refuses what Land cannot ask for: anything but a TODO
// whose pull request is open at the head the person saw.
func mythicalLandable(item db.MythicalItem, head string) error {
	checks := mythicalChecksOf(item)
	switch {
	case item.Source != "issue" || !item.IssueNumber.Valid || !checks.Todo && checks.AutoTodo == "":
		return pkgerrors.Conflict("only a TODO is landed")
	case item.State != "proposed" || !item.PRNumber.Valid || item.PRState != "open" && item.PRState != "":
		return pkgerrors.Conflict("only a TODO whose pull request is open is landed")
	case checks.ForeignHead != "":
		return pkgerrors.Conflict("someone else pushed to this pull request; a person decides on GitHub")
	case item.PRHead != head:
		return pkgerrors.Conflict("the pull request changed since you saw it")
	}
	return nil
}

// maintainerPerson is the person userID as GitHub knows them now, when the
// repository's policy names them (or names no one) and GitHub counts them a
// maintainer; anything else is refused before GitHub is written.
func (s *MythicalService) maintainerPerson(ctx context.Context, repositoryID, userID int64, act string) (mythicalGitHubRepo, gitHubActor, error) {
	accountID, err := s.personGitHubID(ctx, userID, act)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	gh, err := s.stackGitHub(ctx, repositoryID)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	policy, err := s.stackPolicy(ctx, repositoryID)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	account, err := s.github.Account(ctx, gh, accountID)
	if err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	}
	if account.ID != accountID || !policy.maintains(account.Login) {
		return mythicalGitHubRepo{}, gitHubActor{}, pkgerrors.Forbidden("only a maintainer the factory's policy names may " + act)
	}
	if maintainer, err := s.github.Maintainer(ctx, gh, account); err != nil {
		return mythicalGitHubRepo{}, gitHubActor{}, err
	} else if !maintainer {
		return mythicalGitHubRepo{}, gitHubActor{}, pkgerrors.Forbidden("only a maintainer of " + gh.Owner + "/" + gh.Name + " on GitHub may " + act)
	}
	return gh, account, nil
}

// landedByMaintainer reports whether an automerge label the App applied is a
// maintainer's Land for the head the stack is about to merge: recorded for
// exactly that head, by a person the policy still names and, with no list,
// GitHub still counts a maintainer.
func (st *mythicalItemStep) landedByMaintainer(ctx context.Context, item db.MythicalItem, applier *mythicalLabelApplier, policy factoryGitHubPolicy) (bool, error) {
	land := mythicalChecksOf(item).Land
	if land == nil || land.Head != item.PRHead || !applier.present() || !applier.ViaApp || !policy.maintains(land.By) {
		return false, nil
	}
	if policy.namesMaintainers() {
		return true, nil
	}
	account, err := st.s.github.Account(ctx, *st.gh, land.Account)
	if err != nil {
		return false, err
	}
	if account.ID != land.Account || account.Login != land.By {
		return false, nil
	}
	return st.s.github.Maintainer(ctx, *st.gh, account)
}

// personGitHubID is the numeric id of the GitHub account the person signed
// in with: a "github" account, else the GitHub sign-in's historical
// "workos" row (resolveUserGitHubAccessToken's order). A login is never
// trusted from the profile: it can be renamed.
func (s *MythicalService) personGitHubID(ctx context.Context, userID int64, act string) (int64, error) {
	accounts, err := s.queries().ListUserOAuthAccounts(ctx, userID)
	if err != nil {
		return 0, err
	}
	for _, provider := range []string{"github", "workos"} {
		for _, account := range accounts {
			if !strings.EqualFold(strings.TrimSpace(account.Provider), provider) {
				continue
			}
			if id, err := strconv.ParseInt(strings.TrimSpace(account.ProviderUserID), 10, 64); err == nil && id > 0 {
				return id, nil
			}
		}
	}
	return 0, pkgerrors.Forbidden("connect your GitHub account to " + act)
}

func (g *mythicalGitHubAPI) Account(ctx context.Context, gh mythicalGitHubRepo, id int64) (gitHubActor, error) {
	var account gitHubActor
	status, err := g.api.request(ctx, gh.Token, http.MethodGet, "/user/"+strconv.FormatInt(id, 10), nil, &account)
	if err != nil {
		return gitHubActor{}, err
	}
	if status != http.StatusOK {
		return gitHubActor{}, landingGitHubStatusError(status, gh.Owner, gh.Name, "read the account")
	}
	return account, nil
}
