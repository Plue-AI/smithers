// Command resolve-agent-message records an operator's reconciliation of an
// ambiguous message dispatch. It never launches or retries execution.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/jobs"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := run(ctx, os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, output io.Writer) error {
	flags := flag.NewFlagSet("resolve-agent-message", flag.ContinueOnError)
	flags.SetOutput(output)
	repositoryID := flags.Int64("repository", 0, "repository ID")
	userID := flags.Int64("user", 0, "message author ID")
	messageID := flags.Int64("message", 0, "message ID")
	outcome := flags.String("outcome", "", "completed, failed, or cancelled after reconciliation")
	evidence := flags.String("evidence", "", "observed outcome and cleanup evidence; no credentials")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() != 0 || *repositoryID <= 0 || *userID <= 0 || *messageID <= 0 || strings.TrimSpace(*evidence) == "" || len(*evidence) > 4096 {
		return errors.New("positive --repository, --user, --message and --evidence (1-4096 bytes) are required")
	}
	resolution := jobs.UncertainResolution(*outcome)
	switch resolution {
	case jobs.ResolveCompleted, jobs.ResolveFailed, jobs.ResolveCancelled:
	default:
		return errors.New("--outcome must be completed, failed, or cancelled; automatic retry is not supported")
	}
	databaseURL := os.Getenv("SMITHERS_DATABASE_URL")
	if databaseURL == "" {
		return errors.New("SMITHERS_DATABASE_URL is required")
	}
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return errors.New("invalid database configuration")
	}
	defer pool.Close()
	store, err := jobs.NewStore(pool)
	if err != nil {
		return err
	}
	scope := jobs.Scope{TenantID: fmt.Sprintf("repository:%d", *repositoryID), PrincipalID: fmt.Sprintf("user:%d", *userID)}
	operation, err := store.GetByRequest(ctx, scope, "agent-run-dispatch", fmt.Sprintf("agent-message:%d", *messageID))
	if err != nil {
		return err
	}
	receipt, _ := json.Marshal(map[string]any{"messageId": *messageID, "operatorEvidence": strings.TrimSpace(*evidence), "outcome": *outcome})
	if err := store.ResolveUncertain(ctx, scope, operation.ID, resolution, receipt); err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "Message %d resolved as %s\n", *messageID, *outcome)
	return err
}
