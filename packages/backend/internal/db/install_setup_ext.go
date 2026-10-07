package db

import "context"

// InstallAppConversionCheckpointed distinguishes a durable sealed outcome from
// an ambiguous consumed code. The one-time GitHub exchange cannot be retried.
func (q *Queries) InstallAppConversionCheckpointed(ctx context.Context, operation string) (bool, error) {
	var saved bool
	err := q.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM product_job_dispatches WHERE operation_id=$1 AND external_receipt ? 'sealed_conversion')`, operation).Scan(&saved)
	return saved, err
}
