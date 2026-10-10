package machined

import (
	"context"
	"github.com/jackc/pgx/v5"
)

type sessionAdmissionTransactionKey struct{}
type sessionAdmissionTransaction struct {
	branch string
	tx     pgx.Tx
	// checks run on tx just before its holder commits; nil when the holder
	// runs none (CheckedSessionAdmissionTransaction).
	checks *[]func(context.Context, pgx.Tx) error
}

// The composed host alone supplies the transaction holding current identity
// authority. Nested spawn receipts reuse it and never commit or reacquire it.
func WithSessionAdmissionTransaction(ctx context.Context, branch string, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, sessionAdmissionTransactionKey{}, sessionAdmissionTransaction{branch: branch, tx: tx})
}

// WithCheckedSessionAdmissionTransaction is WithSessionAdmissionTransaction
// for a holder that keeps tx open across a long effect, such as a machine
// start's VM boot, and commits only after CheckSessionAdmission. Member reads
// on such a transaction take key-share locks and recheck before the commit
// (RecheckBeforeAdmissionCommit), so a row lock is never held across the boot
// and unrelated member writes (view state, last login) never wait on it (#3759).
func WithCheckedSessionAdmissionTransaction(ctx context.Context, branch string, tx pgx.Tx) context.Context {
	checks := []func(context.Context, pgx.Tx) error{}
	return context.WithValue(ctx, sessionAdmissionTransactionKey{}, sessionAdmissionTransaction{branch: branch, tx: tx, checks: &checks})
}

func SessionAdmissionTransaction(ctx context.Context, branch string) pgx.Tx {
	held, ok := ctx.Value(sessionAdmissionTransactionKey{}).(sessionAdmissionTransaction)
	if !ok || held.branch != branch {
		return nil
	}
	return held.tx
}

// RecheckBeforeAdmissionCommit registers check to run on branch's held
// transaction just before its holder commits. It reports false when the
// holder runs no checks; the caller then keeps its row locks until commit.
func RecheckBeforeAdmissionCommit(ctx context.Context, branch string, check func(context.Context, pgx.Tx) error) bool {
	held, ok := ctx.Value(sessionAdmissionTransactionKey{}).(sessionAdmissionTransaction)
	if !ok || held.branch != branch || held.checks == nil {
		return false
	}
	*held.checks = append(*held.checks, check)
	return true
}

// CheckSessionAdmission runs the checks registered on branch's held
// transaction, in order. The holder commits only when it returns nil: a check
// that finds its authorization gone fails the whole effect closed.
func CheckSessionAdmission(ctx context.Context, branch string) error {
	held, ok := ctx.Value(sessionAdmissionTransactionKey{}).(sessionAdmissionTransaction)
	if !ok || held.branch != branch || held.checks == nil {
		return nil
	}
	for _, check := range *held.checks {
		if err := check(ctx, held.tx); err != nil {
			return err
		}
	}
	return nil
}
