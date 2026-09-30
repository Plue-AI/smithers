package services

import (
	"bytes"
	"context"
	"encoding/json"
	stdErrors "errors"
	"regexp"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	pkgerrors "github.com/smithersai/smithers/packages/backend/internal/pkg/errors"
)

// The signup profile is what a person entered during signup after GitHub
// sign-in: the account claim (full name and account name) and the poll
// answers, with the step they reached. It is keyed by the session user and
// stored as one JSON document in onboarding_answers, so a second browser
// resumes it. The account name is a claim on the person's own profile, not a
// namespace reservation.

// SignupProfileStore is the persistence the signup profile needs; *db.Queries
// satisfies it.
type SignupProfileStore interface {
	GetOnboardingAnswers(ctx context.Context, userID int64) (db.GetOnboardingAnswersRow, error)
	UpsertOnboardingAnswers(ctx context.Context, arg db.UpsertOnboardingAnswersParams) (db.UpsertOnboardingAnswersRow, error)
}

// SignupAnswer is one poll answer: a single choice or free text, or a set of
// choices.
type SignupAnswer struct {
	One  string
	Many []string
	many bool
}

func (a SignupAnswer) MarshalJSON() ([]byte, error) {
	if a.many {
		if a.Many == nil {
			return []byte("[]"), nil
		}
		return json.Marshal(a.Many)
	}
	return json.Marshal(a.One)
}

func (a *SignupAnswer) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		var many []string
		if err := json.Unmarshal(trimmed, &many); err != nil {
			return err
		}
		*a = SignupAnswer{Many: many, many: true}
		return nil
	}
	var one string
	if err := json.Unmarshal(trimmed, &one); err != nil {
		return err
	}
	*a = SignupAnswer{One: one}
	return nil
}

// SignupProfile is the stored document and the request body of a write.
type SignupProfile struct {
	Name     string                  `json:"name"`
	Account  string                  `json:"account"`
	Stage    string                  `json:"stage"`
	Question int                     `json:"question"`
	Answers  map[string]SignupAnswer `json:"answers"`
	Repo     string                  `json:"repo,omitempty"`
}

// SignupProfileReceipt answers a read or a write. Profile is nil when the
// caller has saved none.
type SignupProfileReceipt struct {
	Profile   *SignupProfile `json:"profile"`
	UpdatedAt *time.Time     `json:"updated_at,omitempty"`
}

const (
	signupNameMax      = 200
	signupAnswersMax   = 32
	signupAnswerKeyMax = 64
	signupAnswerMax    = 2000
	signupChoicesMax   = 32
	signupRepoMax      = 200
	signupQuestionMax  = 64
)

// Account names are URL path segments: lowercase letters, digits and
// hyphens, 2–39 characters, starting and ending with a letter or digit.
var signupAccountName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,37}[a-z0-9]$`)

var signupStages = map[string]bool{"poll": true, "ready": true, "done": true}

type SignupProfileService struct {
	store SignupProfileStore
}

func NewSignupProfileService(store SignupProfileStore) *SignupProfileService {
	return &SignupProfileService{store: store}
}

func profileUnavailable(err error) error {
	return pkgerrors.New(pkgerrors.CodeProfileUnavailable, "signup profile store unavailable").WithCause(err)
}

// Get returns the caller's saved profile, or a receipt with no profile.
func (s *SignupProfileService) Get(ctx context.Context, userID int64) (SignupProfileReceipt, error) {
	row, err := s.store.GetOnboardingAnswers(ctx, userID)
	if stdErrors.Is(err, pgx.ErrNoRows) {
		return SignupProfileReceipt{}, nil
	}
	if err != nil {
		return SignupProfileReceipt{}, profileUnavailable(err)
	}
	var profile SignupProfile
	if err := json.Unmarshal(row.Answers, &profile); err != nil {
		return SignupProfileReceipt{}, pkgerrors.Internal("stored signup profile is unreadable").WithCause(err)
	}
	return receiptOf(profile, row.UpdatedAt.Time, row.UpdatedAt.Valid), nil
}

// Put validates and replaces the caller's whole profile.
func (s *SignupProfileService) Put(ctx context.Context, userID int64, profile SignupProfile) (SignupProfileReceipt, error) {
	if fieldErrors := validateSignupProfile(profile); len(fieldErrors) > 0 {
		return SignupProfileReceipt{}, pkgerrors.ValidationFailed(fieldErrors...)
	}
	if profile.Answers == nil {
		profile.Answers = map[string]SignupAnswer{}
	}
	document, err := json.Marshal(profile)
	if err != nil {
		return SignupProfileReceipt{}, pkgerrors.Internal("signup profile could not be encoded").WithCause(err)
	}
	row, err := s.store.UpsertOnboardingAnswers(ctx, db.UpsertOnboardingAnswersParams{UserID: userID, Answers: document})
	if err != nil {
		return SignupProfileReceipt{}, profileUnavailable(err)
	}
	return receiptOf(profile, row.UpdatedAt.Time, row.UpdatedAt.Valid), nil
}

func receiptOf(profile SignupProfile, updatedAt time.Time, valid bool) SignupProfileReceipt {
	receipt := SignupProfileReceipt{Profile: &profile}
	if valid {
		at := updatedAt.UTC()
		receipt.UpdatedAt = &at
	}
	return receipt
}

func validateSignupProfile(profile SignupProfile) []pkgerrors.FieldError {
	var out []pkgerrors.FieldError
	invalid := func(field string) {
		out = append(out, pkgerrors.FieldError{Resource: "SignupProfile", Field: field, Code: "invalid"})
	}
	if profile.Name == "" || !utf8.ValidString(profile.Name) || utf8.RuneCountInString(profile.Name) > signupNameMax {
		invalid("name")
	}
	if !signupAccountName.MatchString(profile.Account) {
		invalid("account")
	}
	if !signupStages[profile.Stage] {
		invalid("stage")
	}
	if profile.Question < 0 || profile.Question > signupQuestionMax {
		invalid("question")
	}
	if utf8.RuneCountInString(profile.Repo) > signupRepoMax {
		invalid("repo")
	}
	if len(profile.Answers) > signupAnswersMax {
		invalid("answers")
		return out
	}
	for key, answer := range profile.Answers {
		if key == "" || len(key) > signupAnswerKeyMax || !validSignupAnswer(answer) {
			invalid("answers")
			break
		}
	}
	return out
}

func validSignupAnswer(answer SignupAnswer) bool {
	if !answer.many {
		return utf8.ValidString(answer.One) && utf8.RuneCountInString(answer.One) <= signupAnswerMax
	}
	if len(answer.Many) > signupChoicesMax {
		return false
	}
	for _, choice := range answer.Many {
		if !utf8.ValidString(choice) || utf8.RuneCountInString(choice) > signupAnswerMax {
			return false
		}
	}
	return true
}
