package services

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const gitHubReviews = "pulls/reviews"
const gitHubReviewComments = "pulls/comments"

// Lifecycle versions are part of the TODO projection, protected by the stack
// lock. Delivery receipts and activity remain in the shared product journal.
type todoGitHubInput struct {
	Key         string          `json:"key"`
	Version     string          `json:"version"`
	Text        string          `json:"text"`
	Actor       json.RawMessage `json:"by"`
	Hidden      bool            `json:"hidden,omitempty"`
	ReviewState string          `json:"review_state,omitempty"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

// EnableTodoSteering selects the shared transactional dispatcher. Admission
// still requires a pinned TODO composition and a bound run; no host fallback.
func (s *MythicalService) EnableTodoSteering() { s.todoSteering = true }

func (s *MythicalService) consumeGitHubReviewTodos(ctx context.Context, tx pgx.Tx, fetched gitHubFetchedObject) (json.RawMessage, error) {
	if s == nil || s.store == nil {
		return nil, gitHubReviewUnavailable()
	}
	source, err := lockFetchedRepo(ctx, tx, fetched.Repo)
	if err != nil {
		return nil, err
	}
	if s.installGitHubSync == nil || source.GithubRepositoryID.Int64 != fetched.GitHubRepository || source.InstallationID.Int64 != fetched.Installation {
		return nil, gitHubFetchUnavailable()
	}
	if err := s.installGitHubSync.authorizeFetched(ctx, source); err != nil {
		return nil, err
	}
	var object struct {
		gitHubReviewInput
		UpdatedAt   time.Time `json:"updated_at"`
		SubmittedAt time.Time `json:"submitted_at"`
		Deleted     bool      `json:"deleted"`
		App         *struct {
			ID int64 `json:"id"`
		} `json:"performed_via_github_app"`
	}
	if json.Unmarshal(fetched.Object, &object) != nil || object.ID <= 0 || object.User.ID <= 0 || object.User.Login == "" {
		return nil, errors.New("invalid fetched review author or identity")
	}
	// Sealed App identity must be available even for record-only inputs: an App
	// comment can never acquire authority through a roster/login collision.
	if s.publication == nil || s.publication.app == nil {
		return nil, gitHubReviewUnavailable()
	}
	app, err := s.publication.app.Load(ctx)
	if err != nil {
		return nil, err
	}
	ownApp := object.App != nil && object.App.ID == app.ID || object.User.Type == "Bot" && object.User.Login == app.Slug+"[bot]"
	kind := "review"
	text := ""
	if fetched.Resource == gitHubReviews {
		text, err = normalizeGitHubReviewText(object.gitHubReviewInput, 0)
	} else {
		var comment gitHubReviewLine
		if err = json.Unmarshal(fetched.Object, &comment); err == nil {
			text, err = normalizeGitHubCommentText(comment, fetched.Resource == gitHubReviewComments, 0)
		}
		kind = "conversation_comment"
		if fetched.Resource == gitHubReviewComments {
			kind = "review_comment"
		}
	}
	if err != nil {
		return nil, err
	}
	if fetched.Resource != gitHubReviews && fetched.Resource != gitHubReviewComments && fetched.Resource != gitHubConversationComments {
		return nil, gitHubFetchUnavailable()
	}
	updated := object.UpdatedAt
	if updated.IsZero() {
		updated = object.SubmittedAt
	}
	if updated.IsZero() {
		return nil, errors.New("review version has no timestamp")
	}
	key := kind + ":" + strconv.FormatInt(object.ID, 10)
	q := db.New(tx)
	installRepository, err := InstallRepositoryID(ctx, q)
	if err != nil {
		return nil, err
	}
	repositories, err := q.ListRepositoryIDsForGitHubSource(ctx, source.OwnerLogin, source.RepoName)
	if err != nil {
		return nil, err
	}
	changed := 0
	for _, repository := range repositories {
		if repository != installRepository {
			continue
		}
		owner, repo, err := resolveGitHubDestination(ctx, q, nil, 0, repository, "", "")
		if err != nil {
			return nil, err
		}
		if !strings.EqualFold(owner, source.OwnerLogin) || !strings.EqualFold(repo, source.RepoName) {
			continue
		}
		if _, err = tx.Exec(ctx, `SELECT 1 FROM mythical_stacks WHERE repository_id=$1 FOR UPDATE`, repository); err != nil {
			return nil, err
		}
		stack, err := q.GetMythicalStack(ctx, repository)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		items, err := q.ListMythicalGitHubBranchItems(ctx, repository)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if !mythicalTodo(item) || !item.PRNumber.Valid || item.PRNumber.Int64 != fetched.Number {
				continue
			}
			checks := mythicalChecksOf(item)
			index := -1
			for i, prior := range checks.GitHubInputs {
				if prior.Key == key {
					index = i
					break
				}
			}
			duplicate, stale := false, false
			if index >= 0 {
				duplicate = checks.GitHubInputs[index].Version == fetched.Version
				stale = checks.GitHubInputs[index].UpdatedAt.After(updated)
			}
			var personID int64
			// GitHub's numeric identity, never author_association or an old login.
			err = tx.QueryRow(ctx, `SELECT c.user_id FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.repository_id=$1 AND c.github_id=$2 AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND NOT u.prohibit_login AND u.deleted_at IS NULL FOR SHARE OF c,u`, repository, object.User.ID).Scan(&personID)
			if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return nil, err
			}
			active := personID > 0
			actor, _ := json.Marshal(map[string]any{"kind": "github", "login": object.User.Login, "color_index": 7})
			attribution := map[string]string{"github": object.User.Login}
			if active {
				role, err := InstallRoleOf(ctx, q, personID)
				if err != nil {
					return nil, err
				}
				active = role != ""
				if active {
					person, err := q.GetUserByID(ctx, personID)
					if err != nil {
						return nil, err
					}
					actor = todoActor(ctx, person)
					attribution = todoActorRef(ctx, person)
				}
			}
			priorSteer := -1
			for i, feedback := range checks.Steers {
				if feedback.Request == "github:"+key {
					priorSteer = i
					break
				}
			}
			held := priorSteer >= 0 && checks.Steers[priorSteer].ReleasePending
			change := "created"
			if index >= 0 {
				change = "edited"
			}
			if object.Deleted {
				change = "deleted"
			}
			// Once a durable runtime intent exists, edits are activity-only: replacing
			// an in-flight keyed remote effect would violate at-most-once delivery.
			consumed := priorSteer >= 0 && !held
			if priorSteer >= 0 {
				var intent bool
				if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_requests WHERE operation='flow.runtime.steer' AND request_id=$1)`, "todo-steer:"+checks.Steers[priorSteer].ID).Scan(&intent); err != nil {
					return nil, err
				}
				consumed = consumed || intent
			}
			decision := decideGitHubFact(mythicalGitHubFact{Kind: kind, Review: &gitHubReviewFact{State: object.State, Change: change, ActiveMember: active, OwnApp: ownApp, Duplicate: duplicate, Stale: stale, Held: held, Consumed: consumed, Empty: strings.TrimSpace(text) == ""}}, mythicalGitHubFactItem{State: todoState(item)}, s.now())
			if decision.Review == nil {
				continue
			}
			effect := decision.Review
			reopened := effect.Input == "steer" && todoReopenedAttempt(item) && item.State == "proposed"
			_, ready := s.launcher.(mythicalSteerer)
			if effect.Input == "steer" || effect.Input == "hold" {
				if !s.todoSteering || s.todoFlow == nil || !ready {
					return nil, gitHubReviewUnavailable()
				}
				if effect.Input == "steer" {
					if _, pinned := mythicalPinOf(item); !pinned || !stack.ActorUserID.Valid || (reopened && (s.lanes == nil || mythicalMergeFenced(item))) || (!reopened && (!todoSteerReady(item) || item.RequestRunID == "" || item.WorkspaceID == "")) {
						return nil, gitHubReviewUnavailable()
					}
				}
			}
			input := todoGitHubInput{Key: key, Version: fetched.Version, Text: text, Actor: actor, Hidden: effect.Activity == "hide", ReviewState: object.State, UpdatedAt: updated}
			if index < 0 {
				checks.GitHubInputs = append(checks.GitHubInputs, input)
			} else {
				checks.GitHubInputs[index] = input
			}
			next := item
			if reopened {
				next = queueReopenedTodo(item)
				queued := mythicalChecksOf(next)
				queued.GitHubInputs = checks.GitHubInputs
				checks = queued
			}
			if effect.Input == "withdraw" && priorSteer >= 0 {
				checks.Steers = append(checks.Steers[:priorSteer], checks.Steers[priorSteer+1:]...)
			}
			var feedback todoSteer
			if (effect.Input == "steer" || effect.Input == "hold") && strings.TrimSpace(text) != "" {
				feedback = todoSteer{ID: uuid.NewString(), Request: "github:" + key, Credential: "github", GitHubAuthor: object.User.ID, Author: personID, Text: text, By: actor, Attribution: attribution, At: s.now().UTC(), Attempt: item.Attempt, ReleasePending: effect.Input == "hold" || reopened}
				if reopened || item.State == "blocked" || item.State == "queued" || item.State == "retrying" {
					feedback.Attempt++
				}
				if priorSteer >= 0 {
					feedback.ID = checks.Steers[priorSteer].ID
					checks.Steers[priorSteer] = feedback
				} else {
					checks.Steers = append(checks.Steers, feedback)
				}
				if effect.Input == "steer" {
					checks.Land = nil
					next.CandidateVerified = false
					if decision.Event == "working" && !reopened {
						next.State = "running"
						next.NextAttemptAt = pgtype.Timestamptz{}
					}
				}
			}
			next.Checks = checks.encode()
			saved, err := q.SaveMythicalItem(ctx, next)
			if err != nil {
				return nil, err
			}
			data, _ := json.Marshal(map[string]any{"item": uuidString(item.ID), "n": mythicalItemNumber(item), "kind": "github", "object": key, "version": fetched.Version, "text": text, "by": json.RawMessage(actor), "hidden": input.Hidden, "from": todoState(item), "to": todoState(saved)})
			if _, err := jobs.RecordFactInTx(ctx, tx, todoOperationScope(saved), uuid.NewString(), "todo.github_input", todoState(saved), data); err != nil {
				return nil, err
			}
			if feedback.ID != "" && effect.Input == "steer" && !reopened {
				if err := s.admitTodoSteerIntent(ctx, tx, stack, saved, feedback); err != nil {
					return nil, err
				}
			}
			s.itemChanged(ctx, q, stack, saved.ID)
			changed++
		}
	}
	return json.Marshal(map[string]int{"todos": changed})
}

// The held input's GitHub identity must still belong to the same active person.
// Locks also serialize revocation with transactional launch/steer admission.
func currentGitHubFeedbackAuthor(ctx context.Context, tx pgx.Tx, repository int64, feedback todoSteer) (bool, error) {
	var id int64
	err := tx.QueryRow(ctx, `SELECT c.user_id FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.repository_id=$1 AND c.github_id=$2 AND c.user_id=$3 AND c.suspended_at IS NULL AND c.permission IN ('write','admin') AND NOT u.prohibit_login AND u.deleted_at IS NULL FOR SHARE OF c,u`, repository, feedback.GitHubAuthor, feedback.Author).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
