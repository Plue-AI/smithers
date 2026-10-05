package compose

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
)

// This short J4 rehearsal runs the same real install, PostgreSQL, GitHub fake
// and packaged Flow host as J1. The outside actor pushes a broken flow; Home's
// HTTP and live boundaries observe the actual failed import, never seeded state.
func TestJ4BackgroundRunsRehearsal(t *testing.T) {
	t.Setenv("SMITHERS_FEATURE_FLAGS_FLOW_LOAD", "true")
	r := newRehearsal(t, "SMITHERS_J4_BACKGROUND_REHEARSAL", "C-J4-background", "bg-")
	if !r.install("0 Install through Machine ready") {
		return
	}
	r.step("19 Retry and dismiss failed background runs", "GitHub push; live home; GET /api/runs; POST /api/runs/{id}", "failed import on Home; one retry for two presses; durable dismissal; member 403", "T-APP-01", r.backgroundRuns)
}

func (r *rehearsal) backgroundRuns() error {
	if _, err := r.pushGitHubMain("Break a repository flow", map[string]string{"flows/todo/flow.ts": "export default (\n"}); err != nil {
		return err
	}
	read := func() ([]db.BackgroundRun, error) {
		data, err := r.expect("GET", "/api/runs", "", 200)
		var rows []db.BackgroundRun
		if err == nil {
			err = json.Unmarshal(data, &rows)
		}
		return rows, err
	}
	wait := func(previous string) (db.BackgroundRun, error) {
		for deadline := time.Now().Add(5 * time.Minute); ; time.Sleep(500 * time.Millisecond) {
			rows, err := read()
			if err != nil {
				return db.BackgroundRun{}, err
			}
			for _, row := range rows {
				if strings.HasPrefix(row.ID, "flow-load:") && row.ID != previous {
					return row, nil
				}
			}
			if time.Now().After(deadline) {
				return db.BackgroundRun{}, fmt.Errorf("no failed background load after broken flow: %s", r.flowLoadState())
			}
		}
	}
	failed, err := wait("")
	if err != nil {
		return err
	}
	if failed.State != "failed" || !strings.Contains(failed.Detail, "flows/todo/flow.ts") {
		return fmt.Errorf("failure row loses file error: %+v", failed)
	}
	owner, err := r.openLive(r.jar)
	if err != nil {
		return err
	}
	_, err = owner.subscribe("home")
	if err != nil {
		return err
	}
	home, err := owner.wait("home", 10*time.Second, func(frame liveFrame) bool { return strings.Contains(string(frame.Data), failed.ID) })
	if err != nil {
		return err
	}
	if !strings.Contains(string(home.Data), failed.ID) {
		return fmt.Errorf("live Home omitted failed load %s: %s", failed.ID, home.Data)
	}
	before, err := r.flowLoadCommits()
	if err != nil {
		return err
	}
	for range 2 {
		if _, err = r.expect("POST", "/api/runs/"+failed.ID, `{"op":"retry"}`, 202); err != nil {
			return err
		}
	}
	retry, err := wait(failed.ID)
	if err != nil {
		return err
	}
	after, err := r.flowLoadCommits()
	if err != nil {
		return err
	}
	if len(after) != len(before)+1 {
		return fmt.Errorf("two retry presses started %d runs, want 1", len(after)-len(before))
	}
	// Retry again with the source id after completion: its persisted receipt
	// is still the same launch, not another run.
	if _, err = r.expect("POST", "/api/runs/"+failed.ID, `{"op":"retry"}`, 202); err != nil {
		return err
	}
	ben, err := r.member("ben", 201, "maintain")
	if err != nil {
		return err
	}
	alice, err := r.member("alice", 202, "write")
	if err != nil {
		return err
	}
	for _, op := range []string{"retry", "dismiss"} {
		if _, err = r.expectAs(alice, "POST", "/api/runs/"+retry.ID, `{"op":"`+op+`"}`, 403); err != nil {
			return err
		}
	}
	if _, err = r.expectAs(ben, "POST", "/api/runs/"+retry.ID, `{"op":"dismiss"}`, 202); err != nil {
		return err
	}
	if _, err = r.expect("POST", "/api/runs/"+retry.ID, `{"op":"dismiss"}`, 202); err != nil {
		return err
	}
	var dismissedBy int64
	var login string
	var at bool
	if err = r.pool.QueryRow(r.ctx, `SELECT f.dismissed_by,u.username,f.dismissed_at IS NOT NULL FROM flow_loads f JOIN users u ON u.id=f.dismissed_by`).Scan(&dismissedBy, &login, &at); err != nil {
		return err
	}
	if login != "ben" || !at {
		return fmt.Errorf("dismissal attribution: %s %d %t", login, dismissedBy, at)
	}
	data, err := r.expectAs(alice, "GET", "/api/runs", "", 200)
	if err != nil {
		return err
	}
	if strings.Contains(string(data), retry.ID) {
		return fmt.Errorf("member reload still sees dismissed %s", retry.ID)
	}
	r.actual = fmt.Sprintf("Home %s failed; two presses -> one run %s; dismissed by ben; Alice retry/dismiss 403; reload removes row", failed.ID, retry.ID)
	return nil
}
