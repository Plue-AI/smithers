-- name: GetOnboardingAnswers :one
SELECT answers, updated_at
FROM onboarding_answers
WHERE user_id = $1;

-- name: UpsertOnboardingAnswers :one
INSERT INTO onboarding_answers (user_id, answers)
VALUES (sqlc.arg(user_id), sqlc.arg(answers))
ON CONFLICT (user_id)
DO UPDATE SET
    answers    = EXCLUDED.answers,
    updated_at = NOW()
RETURNING answers, updated_at;
