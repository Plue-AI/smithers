package main

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"strings"
	"testing"
)

type kernel struct {
	*strings.Reader
	writes []string
	closed bool
	fail   bool
}

func (k *kernel) Write(p []byte) (int, error) {
	k.writes = append(k.writes, string(p))
	if k.fail && len(k.writes) == 1 {
		return 0, io.ErrShortWrite
	}
	return len(p), nil
}
func (k *kernel) Close() error { k.closed = true; return nil }

func TestWatcherOverflowSysctlInputs(t *testing.T) {
	for _, args := range [][]string{{"/workspace/sysctl", "64"}, {queuePath, "65"}, {"--value=64"}, {"--path=" + queuePath}, {"64"}, {"restore", "16384"}} {
		err := withOverflowLimit(args, func(string) (kernelFile, error) { t.Fatal("opened kernel for caller input"); return nil, nil }, io.Discard, func() error { t.Fatal("waited"); return nil })
		if err == nil {
			t.Fatal("accepted caller input", args)
		}
	}
	for _, saved := range []string{"0\n", "-1\n", "64;exec /workspace/evil", "2147483648\n", "064\n", strings.Repeat("1", 33)} {
		k := &kernel{Reader: strings.NewReader(saved)}
		err := withOverflowLimit(nil, func(path string) (kernelFile, error) {
			if path != queuePath {
				t.Fatal(path)
			}
			return k, nil
		}, io.Discard, func() error { t.Fatal("waited"); return nil })
		if err == nil || len(k.writes) != 0 || !k.closed {
			t.Fatalf("unsafe kernel value %q: %v %+v", saved, err, k)
		}
	}
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "normal-and-cancel", true: "failed-write"}[fail], func(t *testing.T) {
			k := &kernel{Reader: strings.NewReader("16384\n"), fail: fail}
			var receipt bytes.Buffer
			cancelled := errors.New("cancelled")
			err := withOverflowLimit(nil, func(path string) (kernelFile, error) {
				if path != queuePath {
					t.Fatal(path)
				}
				return k, nil
			}, &receipt, func() error {
				if strings.Join(k.writes, ",") != "64\n" || receipt.String() != "ready\n" {
					t.Fatal("not reduced before fixture")
				}
				return cancelled
			})
			if err == nil || strings.Join(k.writes, ",") != "64\n,16384\n" || !k.closed {
				t.Fatalf("restore failed: %v %+v", err, k)
			}
			if !fail && !errors.Is(err, cancelled) {
				t.Fatal(err)
			}
		})
	}
}

type failedReceipt struct{}

func (failedReceipt) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestWatcherOverflowCleanupBeforeReceiptAndAfterCompletion(t *testing.T) {
	for _, ready := range []io.Writer{io.Discard, failedReceipt{}} {
		k := &kernel{Reader: strings.NewReader("8192\n")}
		waited := false
		err := withOverflowLimit(nil, func(string) (kernelFile, error) { return k, nil }, ready, func() error { waited = true; return nil })
		if _, failed := ready.(failedReceipt); failed {
			if waited || !errors.Is(err, io.ErrClosedPipe) {
				t.Fatalf("wait=%v error=%v", waited, err)
			}
		} else if !waited || err != nil {
			t.Fatalf("wait=%v error=%v", waited, err)
		}
		if strings.Join(k.writes, ",") != "64\n,8192\n" || !k.closed {
			t.Fatal("limit not restored", k)
		}
	}
	err := withOverflowLimit(nil, func(string) (kernelFile, error) { return nil, fs.ErrPermission }, io.Discard, func() error { t.Fatal("waited after open refusal"); return nil })
	if !errors.Is(err, fs.ErrPermission) {
		t.Fatal(err)
	}
}
