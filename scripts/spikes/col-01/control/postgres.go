package control

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/smithersai/smithers/packages/backend/testkit/postgresfixture"
)

//go:embed fixture.sql
var fixtureSQL string

type fixture struct {
	dir     string
	pool    *pgxpool.Pool
	started bool
	pgctl   string
}

func runTool(ctx context.Context, binary string, args ...string) error {
	output, err := exec.CommandContext(ctx, binary, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", filepath.Base(binary), err, output)
	}
	return nil
}

func newFixture(ctx context.Context, workspaceID string) (f *fixture, retErr error) {
	initdb, err := exec.LookPath("initdb")
	if err != nil {
		return nil, err
	}
	pgctl, err := exec.LookPath("pg_ctl")
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(os.Getenv("TMPDIR"), "col01-pg-")
	if err != nil {
		return nil, err
	}
	f = &fixture{dir: dir, pgctl: pgctl}
	defer func() {
		if retErr != nil {
			retErr = errors.Join(retErr, f.close())
			f = nil
		}
	}()
	if err := runTool(ctx, initdb, "-D", filepath.Join(dir, "data"), "-U", "col01", "-A", "trust", "--no-locale", "--encoding=UTF8"); err != nil {
		return f, err
	}
	if err := runTool(ctx, pgctl, "-D", filepath.Join(dir, "data"), "-l", filepath.Join(dir, "postgres.log"), "-o", "-k "+dir+" -h ''", "-w", "start"); err != nil {
		log, _ := os.ReadFile(filepath.Join(dir, "postgres.log"))
		return f, fmt.Errorf("%w: %s", err, log)
	}
	f.started = true
	raw := url.URL{Scheme: "postgres", User: url.User("col01"), Path: "/postgres"}
	query := url.Values{"host": []string{dir}, "sslmode": []string{"disable"}}
	raw.RawQuery = query.Encode()
	f.pool, err = postgresfixture.Open(ctx, raw.String(), 4)
	if err != nil {
		return f, err
	}
	if _, err = f.pool.Exec(ctx, fixtureSQL); err != nil {
		return f, fmt.Errorf("control schema: %w", err)
	}
	// Identity and repository fixture values follow the service suite fixtures.
	_, err = f.pool.Exec(ctx, `INSERT INTO users(id,username,lower_username,email,lower_email,display_name) VALUES(1,'col01-owner','col01-owner','col01@example.test','col01@example.test','col01-owner');
	INSERT INTO repositories(id,user_id,name,lower_name,description,is_public,default_bookmark,next_issue_number) VALUES(1,1,'col01','col01','',TRUE,'main',1)`)
	if err != nil {
		return f, err
	}
	_, err = f.pool.Exec(ctx, `INSERT INTO workspaces(id,repository_id,user_id,name,kind,status,vm_id,vcpu_count,memory_mb) VALUES($1::uuid,1,1,'col01-control','container','running',$1::text,4,8192)`, workspaceID)
	return f, err
}

func (f *fixture) close() (retErr error) {
	if f == nil {
		return nil
	}
	if f.pool != nil {
		f.pool.Close()
		f.pool = nil
	}
	if f.started {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		retErr = runTool(ctx, f.pgctl, "-D", filepath.Join(f.dir, "data"), "-m", "fast", "-w", "stop")
		if retErr != nil {
			return retErr
		}
		f.started = false
	}
	return os.RemoveAll(f.dir)
}
