package postgres

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os/exec"
	"path/filepath"

	"github.com/jackc/pgx/v5"
)

// DatabaseSize reads the database authority rather than the size of its live
// files. The caller checks free space before quiescing the install.
func (p *Instance) DatabaseSize(ctx context.Context) (uint64, error) {
	if err := p.maintenanceReady(ctx); err != nil {
		return 0, err
	}
	conn, err := pgx.Connect(ctx, p.ConnectionString)
	if err != nil {
		return 0, errors.New("backup database connection unavailable")
	}
	defer conn.Close(context.WithoutCancel(ctx))
	var size int64
	if err := conn.QueryRow(ctx, "SELECT pg_database_size(current_database())").Scan(&size); err != nil {
		return 0, err
	}
	if size < 0 {
		return 0, errors.New("invalid database size")
	}
	return uint64(size), nil
}

// Dump streams the custom-format dump from this supervised database using the
// same packaged tools as startup. Neither PATH nor inherited PG* variables
// choose a program, database, credential or session option.
func (p *Instance) Dump(ctx context.Context, target io.Writer) error {
	if target == nil {
		return errors.New("backup dump destination required")
	}
	cmd, err := p.maintenanceCommand(ctx, "pg_dump", "--format=custom", "--no-owner", "--no-privileges")
	if err != nil {
		return err
	}
	cmd.Stdout = target
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("packaged pg_dump failed: %w", err)
	}
	return nil
}

// RestoreDump imports into a fresh, staged database owned by Start. The caller
// verifies the manifest and retains live state until this transaction succeeds.
// initdb, major-version validation and process cleanup remain owned by Start.
func (p *Instance) RestoreDump(ctx context.Context, source io.Reader) error {
	if source == nil {
		return errors.New("restore dump source required")
	}
	cmd, err := p.maintenanceCommand(ctx, "pg_restore", "--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", "--dbname=postgres")
	if err != nil {
		return err
	}
	cmd.Stdin = source
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("packaged pg_restore failed: %w", err)
	}
	return nil
}

func (p *Instance) maintenanceReady(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if p == nil || !filepath.IsAbs(p.binDir) || p.done == nil {
		return errors.New("owned postgres maintenance unavailable")
	}
	select {
	case <-p.done:
		return errors.New("owned postgres is stopped")
	default:
		return nil
	}
}

func (p *Instance) maintenanceCommand(ctx context.Context, program string, args ...string) (*exec.Cmd, error) {
	if err := p.maintenanceReady(ctx); err != nil {
		return nil, err
	}
	connection, err := url.Parse(p.ConnectionString)
	if err != nil || connection.User == nil || connection.Scheme != "postgres" {
		return nil, errors.New("invalid owned postgres connection")
	}
	host, port, err := net.SplitHostPort(connection.Host)
	if err != nil || host != "127.0.0.1" || connection.Path != "/postgres" {
		return nil, errors.New("invalid owned postgres connection")
	}
	password, ok := connection.User.Password()
	if !ok {
		return nil, errors.New("owned postgres credential unavailable")
	}
	cmd := exec.CommandContext(ctx, filepath.Join(p.binDir, program), args...)
	// Credentials never appear in argv or tool error output. Discard stderr:
	// database-controlled object names may contain secrets or terminal escapes.
	cmd.Env = append(childEnvironment(), "PGHOST="+host, "PGPORT="+port, "PGUSER="+connection.User.Username(), "PGPASSWORD="+password, "PGDATABASE=postgres", "PGCONNECT_TIMEOUT=5")
	return cmd, nil
}
