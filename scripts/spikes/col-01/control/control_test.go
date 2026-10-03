package control

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestControlSequentialWritesKeepAllSamplesAndVerifyContents(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "real-file.txt")
	seen := 0
	write := func(_ context.Context, content string) error {
		seen++
		if strings.Count(content, "\n") != 400 || !strings.HasPrefix(content, "write="+sequence(seen)+"\n") {
			t.Fatalf("write %d lost the 400-line sequential payload", seen)
		}
		return os.WriteFile(file, []byte(content), 0600)
	}
	read := func(context.Context) ([]byte, error) { return os.ReadFile(file) }
	if err := measure(context.Background(), dir, "control", write, read); err != nil {
		t.Fatal(err)
	}
	if seen != 100 {
		t.Fatalf("got %d writes, want 100", seen)
	}
	f, err := os.Open(filepath.Join(dir, "control.csv"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 101 || strings.Join(rows[0], ",") != "seq,write_ns,content_bytes,sha256" {
		t.Fatalf("unexpected raw rows: %d", len(rows))
	}
	for i, row := range rows[1:] {
		if row[0] != sequence(i+1) {
			t.Fatalf("sample reordered at %d: %v", i+1, row)
		}
	}
	var summary Summary
	data, err := os.ReadFile(filepath.Join(dir, "control-summary.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &summary); err != nil {
		t.Fatal(err)
	}
	if summary.Count != 100 || !summary.Verified || summary.P50NS <= 0 || summary.P95NS < summary.P50NS || summary.P99NS < summary.P95NS {
		t.Fatalf("invalid summary: %+v", summary)
	}
}

func TestControlReadbackFailureDoesNotProduceSuccess(t *testing.T) {
	dir := t.TempDir()
	err := measure(context.Background(), dir, "control", func(context.Context, string) error { return nil }, func(context.Context) ([]byte, error) { return []byte("corrupt"), nil })
	if err == nil || !strings.Contains(err.Error(), "readback mismatch") {
		t.Fatalf("got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "control-summary.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("success summary exists: %v", err)
	}
}

func TestControlCancellationPreventsWritesAndPreservesExistingEvidence(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := measure(ctx, dir, "control", func(context.Context, string) error { t.Fatal("write after cancel"); return nil }, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	path := filepath.Join(dir, "existing.csv")
	if err := os.WriteFile(path, []byte("retained"), 0600); err != nil {
		t.Fatal(err)
	}
	err = measure(context.Background(), dir, "existing", nil, nil)
	if err == nil {
		t.Fatal("existing evidence was not refused")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "retained" {
		t.Fatal("existing evidence overwritten")
	}
}

func TestControlPercentilesRetainColdSampleAndUseNearestRank(t *testing.T) {
	samples := make([]time.Duration, 100)
	for i := range samples {
		samples[i] = time.Duration(100 - i)
	}
	summary := summarize(samples)
	if summary.Count != 100 || summary.P50NS != 50 || summary.P95NS != 95 || summary.P99NS != 99 {
		t.Fatalf("got %+v", summary)
	}
	if samples[0] != 100 {
		t.Fatal("summary reordered raw samples")
	}
}

func TestControlWriteAndReadErrorsStopWithoutSuccess(t *testing.T) {
	for _, stage := range []string{"write", "read"} {
		t.Run(stage, func(t *testing.T) {
			dir := t.TempDir()
			failure := errors.New("dependency failure")
			writes, reads := 0, 0
			err := measure(context.Background(), dir, "control", func(context.Context, string) error {
				writes++
				if stage == "write" {
					return failure
				}
				return nil
			}, func(context.Context) ([]byte, error) { reads++; return nil, failure })
			if !errors.Is(err, failure) || writes != 1 || (stage == "read" && reads != 1) || (stage == "write" && reads != 0) {
				t.Fatalf("failure not propagated at correct boundary: writes=%d reads=%d err=%v", writes, reads, err)
			}
			if _, err := os.Stat(filepath.Join(dir, "control-summary.json")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("failure produced success: %v", err)
			}
		})
	}
}

func TestControlEmptySummaryAndInvalidRun(t *testing.T) {
	if summary := summarize(nil); summary.Count != 0 || summary.P95NS != 0 {
		t.Fatalf("empty percentile invents samples: %+v", summary)
	}
	dir := filepath.Join(t.TempDir(), "unused")
	if err := Run(context.Background(), nil, "", dir); err == nil {
		t.Fatal("missing runtime accepted")
	}
	if _, err := os.Stat(dir); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("invalid run created evidence")
	}
}
