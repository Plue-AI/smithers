// Package control measures the current WriteWorkspaceFile service boundary and
// the ticket's one-exec file-operation alternative against the same real VM.
package control

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/services"
	"github.com/smithersai/smithers/packages/backend/microsandbox"
)

type Summary struct {
	Count    int    `json:"n"`
	P50NS    int64  `json:"p50_ns"`
	P95NS    int64  `json:"p95_ns"`
	P99NS    int64  `json:"p99_ns"`
	Verified bool   `json:"all_readbacks_verified"`
	Method   string `json:"method"`
}

func sequence(n int) string { return strconv.Itoa(n) }

func payload(n int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "write=%d\n", n)
	for line := 2; line <= 400; line++ {
		fmt.Fprintf(&b, "line %03d: collaboration control seed content\n", line)
	}
	return b.String()
}

func summarize(samples []time.Duration) Summary {
	sorted := append([]time.Duration(nil), samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	percentile := func(p float64) int64 {
		if len(sorted) == 0 {
			return 0
		}
		return int64(sorted[int(math.Ceil(float64(len(sorted))*p))-1])
	}
	return Summary{Count: len(samples), P50NS: percentile(.50), P95NS: percentile(.95), P99NS: percentile(.99)}
}

// measure times only writes; each readback is outside its write interval.
// time.Since uses the monotonic reading in time.Now. No sample is discarded.
func measure(ctx context.Context, dir, name string, write func(context.Context, string) error, read func(context.Context) ([]byte, error)) (retErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	for _, suffix := range []string{".csv", "-summary.json"} {
		if _, err := os.Stat(filepath.Join(dir, name+suffix)); err == nil {
			return fmt.Errorf("refusing existing control evidence %s%s", name, suffix)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if write == nil || read == nil {
		return errors.New("control writer and reader required")
	}
	f, err := os.OpenFile(filepath.Join(dir, name+".csv"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { retErr = errors.Join(retErr, f.Close()) }()
	w := csv.NewWriter(f)
	defer func() { w.Flush(); retErr = errors.Join(retErr, w.Error()) }()
	if err := w.Write([]string{"seq", "write_ns", "content_bytes", "sha256"}); err != nil {
		return err
	}
	samples := make([]time.Duration, 0, 100)
	for n := 1; n <= 100; n++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		content := payload(n)
		start := time.Now()
		if err := write(ctx, content); err != nil {
			return fmt.Errorf("write %d: %w", n, err)
		}
		elapsed := time.Since(start)
		data, err := read(ctx)
		if err != nil {
			return fmt.Errorf("readback %d: %w", n, err)
		}
		if string(data) != content {
			return fmt.Errorf("readback mismatch at write %d", n)
		}
		if err := w.Write([]string{sequence(n), strconv.FormatInt(elapsed.Nanoseconds(), 10), strconv.Itoa(len(content)), fmt.Sprintf("%x", sha256.Sum256(data))}); err != nil {
			return err
		}
		w.Flush()
		if err := w.Error(); err != nil {
			return err
		}
		samples = append(samples, elapsed)
	}
	if err := f.Sync(); err != nil {
		return err
	}
	summary := summarize(samples)
	summary.Verified = true
	summary.Method = "100 sequential 400-line writes; host monotonic time; nearest-rank percentiles; every write read back outside timed interval; no warm-up discarded"
	data, err := json.MarshalIndent(summary, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(dir, name+"-summary.json"), append(data, '\n'), 0600)
}

// Run owns only its fixture PostgreSQL process, never the supplied VM.
// The service's provider path currently performs two execs: its canonical path
// guard, then the microsandbox WriteFile operation. The second control records
// the one-exec alternative separately instead of mislabelling either result.
func Run(ctx context.Context, runtime *microsandbox.Runtime, workspaceID, artifactDir string) (retErr error) {
	if runtime == nil || workspaceID == "" {
		return errors.New("control requires live runtime and workspace id")
	}
	if err := os.MkdirAll(artifactDir, 0755); err != nil {
		return err
	}
	fixture, err := newFixture(ctx, workspaceID)
	if err != nil {
		return err
	}
	defer func() { retErr = errors.Join(retErr, fixture.close()) }()
	provider := &runtimeProvider{runtime: runtime}
	svc := services.NewWorkspaceService(db.New(fixture.pool), services.WithWorkspaceSandboxClient(provider), services.WithWorkspaceTransactions(fixture.pool))
	const name = "col01-control.txt"
	write := func(ctx context.Context, content string) error {
		result, err := svc.WriteWorkspaceFile(ctx, workspaceID, 1, 1, name, content)
		if err != nil {
			return err
		}
		if result.Content != content || result.Size != int64(len(content)) || result.Path != name || result.Encoding != "utf-8" {
			return errors.New("service write receipt does not match payload")
		}
		return nil
	}
	read := func(ctx context.Context) ([]byte, error) { return runtime.ReadFile(ctx, workspaceID, name) }
	if err := measure(ctx, artifactDir, "control", write, read); err != nil {
		return err
	}
	if err := measure(ctx, artifactDir, "one-exec-control", func(ctx context.Context, content string) error {
		return runtime.WriteFile(ctx, workspaceID, name, []byte(content), 0644)
	}, read); err != nil {
		return err
	}
	method := map[string]any{"service": "WorkspaceService.WriteWorkspaceFile", "service_path": "sandbox provider with live microsandbox adapter", "service_execs_per_write": 2, "one_exec_path": "microsandbox.Runtime.WriteFile", "one_exec_execs_per_write": 1, "postgres": "isolated local unix socket; product table definitions; fsync enabled; permission and DB work inside service interval", "path_translation": "provider and microsandbox share /workspace", "readback": "real VM Runtime.ReadFile after each write; outside measured interval", "samples_per_path": 100, "warmup_discarded": 0}
	data, err := json.MarshalIndent(method, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(artifactDir, "control-method.json"), append(data, '\n'), 0600)
}
