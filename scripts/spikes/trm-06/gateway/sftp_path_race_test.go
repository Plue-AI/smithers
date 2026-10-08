package main

import (
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
)

// Reply classification and cleanup ordering only; installed SSH and independent
// sentinels, not this test, supply path-confinement acceptance evidence.
func TestSFTPRacedOpenResults(t *testing.T) {
	status := func(code uint32) []byte {
		body := make([]byte, 9)
		body[0] = 101
		binary.BigEndian.PutUint32(body[5:], code)
		return body
	}
	for _, code := range []uint32{2, 3, 4} {
		if err := validateRacedSFTPOpen(status(code), 1, func(byte, uint32, []byte) ([]byte, error) { t.Fatal("refused OPEN used handle"); return nil, nil }); err != nil {
			t.Fatal(err)
		}
	}
	for _, body := range [][]byte{nil, {102}, status(0), status(5), append([]byte{102, 0, 0, 0, 1}, ssh.Marshal(struct{ Handle string }{""})...)} {
		if validateRacedSFTPOpen(body, 1, nil) == nil {
			t.Fatal("ambiguous OPEN accepted")
		}
	}
	opened := append([]byte{102, 0, 0, 0, 1}, ssh.Marshal(struct{ Handle string }{"held"})...)
	for _, fail := range []byte{0, 6, 4} {
		var operations []byte
		err := validateRacedSFTPOpen(opened, 10, func(kind byte, id uint32, body []byte) ([]byte, error) {
			operations = append(operations, kind)
			if (kind == 6 && id != 11) || (kind == 4 && id != 12) {
				t.Fatal("request sequence")
			}
			if kind == fail {
				return nil, errors.New("transport unavailable")
			}
			return status(0), nil
		})
		if (err != nil) != (fail != 0) || len(operations) != 2 || operations[0] != 6 || operations[1] != 4 {
			t.Fatalf("cleanup ordering: %v %v", operations, err)
		}
	}
}

func TestSFTPSynchronizedPathRequiresFreshEvidenceBeforeSSH(t *testing.T) {
	if sftpSynchronizedPathOpen(nil, nil, nil) == nil {
		t.Fatal("missing evidence accepted")
	}
	directory := t.TempDir()
	path := filepath.Join(directory, "sftp-path-races.jsonl")
	if err := os.WriteFile(path, []byte("receipt"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := sftpSynchronizedPathOpen(nil, nil, nil, directory); !errors.Is(err, os.ErrExist) {
		t.Fatal(err)
	}
	body, err := os.ReadFile(path)
	if err != nil || string(body) != "receipt" {
		t.Fatal("existing evidence replaced")
	}
}
