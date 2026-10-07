package machined

import (
	"context"
	"github.com/jackc/pgx/v5"
)

type sessionAdmissionTransactionKey struct{}
type sessionAdmissionTransaction struct {
	branch string
	tx     pgx.Tx
}

// The composed host alone supplies the transaction holding current identity
// authority. Nested spawn receipts reuse it and never commit or reacquire it.
func WithSessionAdmissionTransaction(ctx context.Context, branch string, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, sessionAdmissionTransactionKey{}, sessionAdmissionTransaction{branch, tx})
}
func SessionAdmissionTransaction(ctx context.Context, branch string) pgx.Tx {
	held, ok := ctx.Value(sessionAdmissionTransactionKey{}).(sessionAdmissionTransaction)
	if !ok || held.branch != branch {
		return nil
	}
	return held.tx
}
