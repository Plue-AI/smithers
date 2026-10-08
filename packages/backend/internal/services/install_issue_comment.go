package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

const InstallIssueCommentOperation = "install.issue.comment"

type installIssueCommentJob struct {
	Repository int64  `json:"repository"`
	Requester  int64  `json:"requester"`
	Number     int64  `json:"number"`
	Body       string `json:"body"`
	Login      string `json:"login"`
}

func (s *MythicalService) SetInstallIssueCommentJobs(store *jobs.Store) { s.commentJobs = store }

func validIssueComment(number int64, body, key string) error {
	if number <= 0 || strings.TrimSpace(body) == "" || len(body) > 65536 || key == "" || len(key) > 256 {
		return &TodoControlError{Status: 400, Code: "invalid_issue_comment", Class: "user", Message: "Invalid issue comment"}
	}
	return nil
}

// RequestInstallIssueComment admits a durable write without waiting on GitHub.
// A private delegated confirmation uses admitIssueComment in its own transaction.
func (s *MythicalService) RequestInstallIssueComment(ctx context.Context, repository, number int64, body, key string) (jobs.RequestReceipt, error) {
	if s == nil || s.store == nil || s.github == nil || s.commentJobs == nil {
		return jobs.RequestReceipt{}, issuesUnavailable()
	}
	decision, err := Authorize(ctx, s.queries(), "issue.comment")
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	ctx = WithInstallAuthorization(ctx, "issue.comment", decision)
	if err = validIssueComment(number, body, key); err != nil {
		return jobs.RequestReceipt{}, err
	}
	var receipt jobs.RequestReceipt
	err = pgx.BeginFunc(ctx, s.store, func(tx pgx.Tx) error {
		var err error
		receipt, err = s.admitIssueComment(ctx, tx, repository, number, body, key)
		return err
	})
	return receipt, err
}

func (s *MythicalService) admitIssueComment(ctx context.Context, tx pgx.Tx, repository, number int64, body, key string) (jobs.RequestReceipt, error) {
	if s.commentJobs == nil || s.github == nil {
		return jobs.RequestReceipt{}, confirmationUnavailable()
	}
	if err := validIssueComment(number, body, key); err != nil {
		return jobs.RequestReceipt{}, err
	}
	info := middleware.AuthInfoFromContext(ctx)
	bound, currentRepository, err := lockInstallWriteCredential(ctx, tx, info)
	if err != nil {
		return jobs.RequestReceipt{}, err
	}
	if currentRepository != repository {
		return jobs.RequestReceipt{}, confirmationPermission()
	}
	if _, err = Authorize(bound, db.New(tx), "issue.comment"); err != nil {
		return jobs.RequestReceipt{}, err
	}
	identity, _ := json.Marshal(middleware.CredentialOf(info))
	digest := sha256.Sum256(identity)
	payload, _ := json.Marshal(installIssueCommentJob{repository, info.User.ID, number, body, info.User.Username})
	receipt, err := s.commentJobs.AdmitInTx(bound, tx, jobs.Admission{
		Scope:     jobs.Scope{TenantID: fmt.Sprintf("repository:%d", repository), PrincipalID: "credential:" + hex.EncodeToString(digest[:])},
		Operation: InstallIssueCommentOperation, RequestID: key, Payload: payload,
		AuthorizationContext: identity, EffectPolicy: jobs.EffectUnsafe,
	})
	if errors.Is(err, jobs.ErrPayloadConflict) {
		return jobs.RequestReceipt{}, todoRequestMismatch()
	}
	return receipt, err
}

// HandleInstallIssueComment is attached to the install's shared worker lifecycle.
// Unsafe delivery records uncertainty after a lost reply; it never blindly
// repeats a comment whose acceptance GitHub may have hidden.
func (s *MythicalService) HandleInstallIssueComment(ctx context.Context, lease *jobs.Lease) error {
	claim := lease.Claim()
	var job installIssueCommentJob
	var credential middleware.Credential
	if json.Unmarshal(claim.Payload, &job) != nil || json.Unmarshal(claim.AuthorizationContext, &credential) != nil {
		return lease.Fail(ctx, json.RawMessage(`{"code":"invalid_issue_comment"}`))
	}

	info, err := middleware.ReloadCredential(ctx, s.queries(), credential, time.Now())
	if err != nil && !errors.Is(err, middleware.ErrCredentialGone) {
		return err
	}
	if err != nil || !middleware.BindInstallCredential(info) {
		return lease.Fail(ctx, json.RawMessage(`{"code":"unauthenticated","class":"permission"}`))
	}
	bound := middleware.ContextWithAuthInfo(ctx, info)
	subject := InstallSubject{RepositoryID: job.Repository}
	decision, err := Authorize(bound, s.queries(), "issue.comment", subject)
	if err != nil {
		return lease.Fail(ctx, json.RawMessage(`{"code":"permission","class":"permission"}`))
	}
	bound = WithInstallAuthorization(bound, "issue.comment", decision, subject)
	gh, err := s.stackGitHub(bound, job.Repository)
	if err != nil {
		return err
	}
	// The App writer may look up a prior marker and mint its narrow token.
	// Fence only its actual send: slow reads hold no credential/roster locks.
	bound = context.WithValue(bound, gitHubCommentSendKey{}, gitHubCommentSendFence(func(send func(context.Context) error) error {
		tx, err := s.store.Begin(bound)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback(context.WithoutCancel(bound)) }()
		current, repository, err := lockInstallCredential(bound, tx, info, false)
		if err != nil {
			return err
		}
		if repository != job.Repository || decision.UserID != job.Requester {
			return confirmationPermission()
		}
		if _, err = Authorize(current, db.New(tx), "issue.comment", subject); err != nil {
			return err
		}
		if err = lease.StartExternal(current, json.RawMessage(`{"state":"sending"}`)); err != nil {
			return err
		}
		if err = send(current); err != nil {
			return err
		}
		return tx.Commit(current)
	}))
	body := job.Body + "\n\nRequested by @" + job.Login
	if err = s.github.Comment(bound, gh, job.Number, claim.OperationID, body); err != nil {
		return err
	}
	return lease.Complete(ctx, json.RawMessage(`{"state":"completed"}`))
}

// The provider owns marker lookup/token minting; the worker fences the exact
// write before it starts. Other stack comment callers retain their own guards.
type gitHubCommentSendKey struct{}
type gitHubCommentSendFence func(func(context.Context) error) error

func sendGitHubComment(ctx context.Context, send func(context.Context) error) error {
	if fence, ok := ctx.Value(gitHubCommentSendKey{}).(gitHubCommentSendFence); ok {
		return fence(send)
	}
	return send(ctx)
}

func (s *MythicalService) prepareIssueCommentConfirmation(ctx context.Context, tx pgx.Tx, repository int64, input ConfirmationInput, inspect bool) (preparedConfirmation, error) {
	p := preparedConfirmation{}
	if s.commentJobs == nil || s.github == nil {
		return p, confirmationUnavailable()
	}
	var subject struct {
		Kind string `json:"kind"`
		Ref  string `json:"ref"`
	}
	var request struct {
		Body string `json:"body"`
	}
	if confirmationJSON(input.Subject, &subject) != nil || subject.Kind != "issue" || confirmationJSON(input.Payload, &request) != nil {
		return p, invalidConfirmation()
	}
	number, err := strconv.ParseInt(subject.Ref, 10, 64)
	if err != nil || subject.Ref != strconv.FormatInt(number, 10) || validIssueComment(number, request.Body, input.Key) != nil {
		return p, invalidConfirmation()
	}
	p.subject, _ = json.Marshal(subject)
	p.input, _ = json.Marshal(request)
	p.revision = fmt.Sprintf("%d:%d", repository, number)
	p.title = "#" + subject.Ref
	p.comment = &installIssueCommentJob{Number: number, Body: request.Body}
	if inspect {
		p.card = map[string]any{"kind": "one_click", "action": map[string]string{"tag": "issue.comment", "verb": "Comment"}, "summary": p.title,
			"subject": map[string]string{"kind": "issue", "ref": subject.Ref, "revision": p.revision}, "text": request.Body, "asked_by": todoActor(ctx, *middleware.AuthInfoFromContext(ctx).User)}
	}
	return p, nil
}
