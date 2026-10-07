package services

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	stdErrors "errors"
	"fmt"
	"html"
	"log/slog"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/email"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// EmailQuerier defines the database operations needed by EmailService.
type EmailQuerier interface {
	ListUserEmails(ctx context.Context, userID int64) ([]db.EmailAddress, error)
	GetEmailByID(ctx context.Context, id int64) (db.EmailAddress, error)
	UpsertEmailAddress(ctx context.Context, arg db.UpsertEmailAddressParams) (db.UpsertEmailAddressRow, error)
	DeleteEmail(ctx context.Context, arg db.DeleteEmailParams) error
	GetPrimaryEmail(ctx context.Context, userID int64) (db.EmailAddress, error)
	CreateEmailVerificationToken(ctx context.Context, arg db.CreateEmailVerificationTokenParams) (db.EmailVerificationToken, error)
	GetEmailVerificationTokenByHash(ctx context.Context, tokenHash string) (db.EmailVerificationToken, error)
	ConsumeEmailVerificationToken(ctx context.Context, tokenHash string) (int64, error)
	ActivateEmail(ctx context.Context, arg db.ActivateEmailParams) error
}

// EmailServiceConfig holds configuration for the email service.
type EmailServiceConfig struct {
	// BaseURL is the base URL for email links (e.g. "https://smithers.sh").
	BaseURL string
	// From is the default sender address (e.g. "noreply@smithers.sh").
	From string
}

// EmailService implements email management operations.
type EmailService struct {
	install         *installAccountMutationStore
	installAdmitted bool
	queries         EmailQuerier
	transport       email.Transport
	cfg             EmailServiceConfig
	// spawn is used for async email delivery. Defaults to goroutine.
	// Overridden in tests for synchronous behavior.
	spawn func(func())
}

var emailRandRead = rand.Read
var renderVerificationEmail = email.RenderVerificationEmail

// EmailResponse is the API representation of an email address.
type EmailResponse struct {
	ID          int64     `json:"id"`
	Email       string    `json:"email"`
	IsActivated bool      `json:"is_activated"`
	IsPrimary   bool      `json:"is_primary"`
	CreatedAt   time.Time `json:"created_at"`
}

// AddEmailRequest is the request payload for adding a new email.
type AddEmailRequest struct {
	Email     string `json:"email"`
	IsPrimary bool   `json:"is_primary"`
}

// NewEmailService creates a new EmailService with email delivery transport.
func NewEmailService(q EmailQuerier, transport email.Transport, cfg EmailServiceConfig, options ...EmailServiceOption) *EmailService {
	s := &EmailService{
		queries:   q,
		transport: transport,
		cfg:       cfg,
		spawn:     func(f func()) { go f() },
	}
	for _, option := range options {
		option(s)
	}
	return s
}

// ListEmails returns all emails for the given user.
func (s *EmailService) ListEmails(ctx context.Context, userID int64) ([]EmailResponse, error) {
	if userID <= 0 {
		return nil, pkgerrors.BadRequest("invalid user")
	}

	emails, err := s.queries.ListUserEmails(ctx, userID)
	if err != nil {
		return nil, pkgerrors.Internal("failed to list emails").WithCause(err)
	}

	result := make([]EmailResponse, 0, len(emails))
	for _, e := range emails {
		if e.UserID != userID {
			continue
		}
		result = append(result, mapEmailResponse(e))
	}

	return result, nil
}

// AddEmail creates a new email for the given user.
func (s *EmailService) AddEmail(ctx context.Context, userID int64, req AddEmailRequest) (EmailResponse, error) {
	if s.install != nil && !s.installAdmitted {
		return withInstallAccountMutation(s.install, ctx, userID, "account.email.add", 0, req, func(ctx context.Context, q *db.Queries) (EmailResponse, error) {
			scoped := *s
			scoped.queries, scoped.installAdmitted = q, true
			return scoped.AddEmail(ctx, userID, req)
		})
	}
	if userID <= 0 {
		return EmailResponse{}, pkgerrors.BadRequest("invalid user")
	}

	// Canonicalize to lowercase before validation and storage.
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if err := validateEmail(email); err != nil {
		return EmailResponse{}, err
	}

	row, err := s.queries.UpsertEmailAddress(ctx, db.UpsertEmailAddressParams{
		UserID:      userID,
		IsPrimary:   req.IsPrimary,
		Email:       email,
		LowerEmail:  email,
		IsActivated: false,
	})
	if err != nil {
		if isEmailUniqueViolation(err) {
			return EmailResponse{}, pkgerrors.Conflict("email already exists")
		}
		return EmailResponse{}, pkgerrors.Internal("failed to add email").WithCause(err)
	}

	return EmailResponse{
		ID:          row.ID,
		Email:       row.Email,
		IsActivated: row.IsActivated,
		IsPrimary:   row.IsPrimary,
		CreatedAt:   row.CreatedAt,
	}, nil
}

// DeleteEmail removes an email owned by the given user.
func (s *EmailService) DeleteEmail(ctx context.Context, userID, emailID int64) error {
	if s.install != nil && !s.installAdmitted {
		_, err := withInstallAccountMutation(s.install, ctx, userID, "account.email.delete", emailID, struct{}{}, func(ctx context.Context, q *db.Queries) (struct{}, error) {
			scoped := *s
			scoped.queries, scoped.installAdmitted = q, true
			return struct{}{}, scoped.DeleteEmail(ctx, userID, emailID)
		})
		return err
	}
	if userID <= 0 {
		return pkgerrors.BadRequest("invalid user")
	}
	if emailID <= 0 {
		return pkgerrors.BadRequest("invalid email id")
	}

	email, err := s.queries.GetEmailByID(ctx, emailID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("email not found")
		}
		return pkgerrors.Internal("failed to load email").WithCause(err)
	}
	if email.UserID != userID {
		return pkgerrors.NotFound("email not found")
	}

	if err := s.queries.DeleteEmail(ctx, db.DeleteEmailParams{ID: emailID, UserID: userID}); err != nil {
		return pkgerrors.Internal("failed to delete email").WithCause(err)
	}

	return nil
}

// RequestVerification creates a verification token for the given email and
// sends a verification email asynchronously. The raw token is never returned
// to the caller — it is only delivered via email.
func (s *EmailService) RequestVerification(ctx context.Context, userID, emailID int64) error {
	if s != nil && s.install != nil && !s.installAdmitted {
		var delivery func()
		var admitted context.Context
		_, err := withInstallAccountMutation(s.install, ctx, userID, "account.email.verify", emailID, struct{}{}, func(ctx context.Context, q *db.Queries) (struct{}, error) {
			scoped := *s
			scoped.queries, scoped.installAdmitted = q, true
			// Retain the existing delivery, but queue it only after the token commits.
			scoped.spawn = func(send func()) { delivery = send }
			admitted = context.WithoutCancel(ctx)
			return struct{}{}, scoped.RequestVerification(ctx, userID, emailID)
		})
		if err != nil {
			return err
		}
		if delivery != nil {
			s.spawn(func() {
				// Background delivery must still belong to the live admitted credential.
				_, err := withInstallAccountMutation(s.install, admitted, userID, "account.email.verify", emailID, struct{}{}, func(ctx context.Context, q *db.Queries) (struct{}, error) {
					row, err := q.GetEmailByID(ctx, emailID)
					if err != nil {
						return struct{}{}, err
					}
					if row.UserID != userID {
						return struct{}{}, confirmationPermission()
					}
					delivery()
					return struct{}{}, nil
				})
				if err != nil {
					slog.Error("verification email authorization expired", "error", err)
				}
			})
		}
		return nil
	}
	if userID <= 0 {
		return pkgerrors.BadRequest("invalid user")
	}
	if emailID <= 0 {
		return pkgerrors.BadRequest("invalid email id")
	}
	if s == nil || !email.DeliveryConfigured(s.transport) {
		return pkgerrors.NotFound(email.ErrDeliveryNotConfigured.Error())
	}

	emailAddr, err := s.queries.GetEmailByID(ctx, emailID)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return pkgerrors.NotFound("email not found")
		}
		return pkgerrors.Internal("failed to load email").WithCause(err)
	}
	if emailAddr.UserID != userID {
		return pkgerrors.NotFound("email not found")
	}

	tokenBytes := make([]byte, 32)
	if _, err := emailRandRead(tokenBytes); err != nil {
		return pkgerrors.Internal("failed to generate token").WithCause(err)
	}
	rawToken := hex.EncodeToString(tokenBytes)
	tokenHash := sha256Hex(rawToken)

	_, err = s.queries.CreateEmailVerificationToken(ctx, db.CreateEmailVerificationTokenParams{
		UserID:    userID,
		Email:     emailAddr.Email,
		TokenHash: tokenHash,
		TokenType: "verify",
		ExpiresAt: time.Now().Add(24 * time.Hour),
	})
	if err != nil {
		return pkgerrors.Internal("failed to create verification token").WithCause(err)
	}

	// Build verification URL and send email asynchronously.
	verifyURL := fmt.Sprintf("%s/api/user/emails/verify-token?token=%s", s.cfg.BaseURL, rawToken)
	s.spawn(func() {
		htmlBody, textBody, renderErr := renderVerificationEmail(email.VerificationTemplateData{
			VerifyURL: verifyURL,
			Email:     emailAddr.Email,
		})
		if renderErr != nil {
			slog.Error("failed to render verification email", "email", emailAddr.Email, "error", renderErr)
			return
		}

		msg := email.Message{
			From:    s.cfg.From,
			To:      []string{emailAddr.Email},
			Subject: "Verify your email address — Smithers",
			HTML:    htmlBody,
			Text:    textBody,
		}
		if sendErr := s.transport.Send(context.Background(), msg); sendErr != nil {
			slog.Error("failed to send verification email", "email", emailAddr.Email, "error", sendErr)
		}
	})

	return nil
}

// SendMentionNotification sends a mention notification email for the given user.
// This is a best-effort operation — errors are logged but not returned.
func (s *EmailService) SendMentionNotification(ctx context.Context, toEmail string, username string, subject string, snippet string, url string) {
	s.spawn(func() {
		htmlBody, textBody, renderErr := email.RenderMentionEmail(email.MentionTemplateData{
			Username: username,
			Subject:  subject,
			Snippet:  snippet,
			URL:      url,
		})
		if renderErr != nil {
			slog.Error("failed to render mention email", "email", toEmail, "error", renderErr)
			return
		}

		msg := email.Message{
			From:    s.cfg.From,
			To:      []string{toEmail},
			Subject: fmt.Sprintf("You were mentioned: %s — Smithers", subject),
			HTML:    htmlBody,
			Text:    textBody,
		}
		if sendErr := s.transport.Send(context.Background(), msg); sendErr != nil {
			slog.Error("failed to send mention email", "email", toEmail, "error", sendErr)
		}
	})
}

// SendBillingNotification sends a plain billing lifecycle notice.
// This is best-effort -- errors are logged but not returned.
func (s *EmailService) SendBillingNotification(ctx context.Context, toEmail string, subject string, body string) {
	toEmail = strings.TrimSpace(toEmail)
	subject = strings.TrimSpace(subject)
	body = strings.TrimSpace(body)
	if toEmail == "" || subject == "" || body == "" {
		return
	}
	s.spawn(func() {
		escaped := strings.ReplaceAll(html.EscapeString(body), "\n", "<br>")
		msg := email.Message{
			From:    s.cfg.From,
			To:      []string{toEmail},
			Subject: subject,
			HTML:    "<p>" + escaped + "</p>",
			Text:    body,
		}
		if sendErr := s.transport.Send(context.Background(), msg); sendErr != nil {
			slog.Error("failed to send billing email", "email", toEmail, "error", sendErr)
		}
	})
}

// VerifyEmailResult contains the result of a successful email verification.
type VerifyEmailResult struct {
	UserID int64
	Email  string
}

// VerifyEmail activates the email address a verification token names, then consumes the token.
func (s *EmailService) VerifyEmail(ctx context.Context, rawToken string) (VerifyEmailResult, error) {
	if rawToken == "" {
		return VerifyEmailResult{}, pkgerrors.BadRequest("invalid token")
	}

	tokenHash := sha256Hex(rawToken)
	token, err := s.queries.GetEmailVerificationTokenByHash(ctx, tokenHash)
	if err != nil {
		if stdErrors.Is(err, pgx.ErrNoRows) {
			return VerifyEmailResult{}, pkgerrors.BadRequest("invalid or expired token")
		}
		return VerifyEmailResult{}, pkgerrors.Internal("failed to load token").WithCause(err)
	}

	if token.ExpiresAt.Before(time.Now()) || token.UsedAt.Valid {
		return VerifyEmailResult{}, pkgerrors.BadRequest("invalid or expired token")
	}

	// Find the email ID by address to activate it
	emails, err := s.queries.ListUserEmails(ctx, token.UserID)
	if err != nil {
		return VerifyEmailResult{}, pkgerrors.Internal("failed to load emails for activation").WithCause(err)
	}

	var emailID int64
	for _, e := range emails {
		if strings.EqualFold(e.Email, token.Email) {
			emailID = e.ID
			break
		}
	}

	if emailID == 0 {
		return VerifyEmailResult{}, pkgerrors.NotFound("email not found")
	}

	if err := s.queries.ActivateEmail(ctx, db.ActivateEmailParams{
		ID:     emailID,
		UserID: token.UserID,
	}); err != nil {
		if isEmailUniqueViolation(err) {
			return VerifyEmailResult{}, pkgerrors.Conflict("email address is already verified by another account")
		}
		return VerifyEmailResult{}, pkgerrors.Internal("failed to activate email").WithCause(err)
	}

	// Consume only after activation succeeds, so a failed activation leaves the
	// link retryable. Activation is idempotent; the conditional used_at update
	// still lets exactly one concurrent verification report success.
	rows, err := s.queries.ConsumeEmailVerificationToken(ctx, tokenHash)
	if err != nil {
		return VerifyEmailResult{}, pkgerrors.Internal("failed to consume token").WithCause(err)
	}
	if rows == 0 {
		return VerifyEmailResult{}, pkgerrors.BadRequest("invalid or expired token")
	}

	return VerifyEmailResult{UserID: token.UserID, Email: token.Email}, nil
}

func mapEmailResponse(e db.EmailAddress) EmailResponse {
	return EmailResponse{
		ID:          e.ID,
		Email:       e.Email,
		IsActivated: e.IsActivated,
		IsPrimary:   e.IsPrimary,
		CreatedAt:   e.CreatedAt,
	}
}

func validateEmail(email string) error {
	if email == "" {
		return emailValidationError("email", "missing_field")
	}
	if len(email) > 254 {
		return emailValidationError("email", "invalid")
	}
	parsed, err := mail.ParseAddress(email)
	if err != nil {
		return emailValidationError("email", "invalid")
	}
	// Reject RFC-5322 display-name / angle-addr forms ("Name <a@b>", "<a@b>"):
	// callers store this value verbatim as the recipient, so it must already be a
	// bare address. AddEmail lowercases+trims before calling, so an exact match
	// against the parsed bare address is the correct guard.
	if parsed.Name != "" || parsed.Address != email {
		return emailValidationError("email", "invalid")
	}
	return nil
}

func emailValidationError(field, code string) error {
	return pkgerrors.ValidationFailed(pkgerrors.FieldError{
		Resource: "Email",
		Field:    field,
		Code:     code,
	})
}

func isEmailUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if stdErrors.As(err, &pgErr) {
		return pgErr.Code == "23505"
	}
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "duplicate key") || strings.Contains(lower, "unique")
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
