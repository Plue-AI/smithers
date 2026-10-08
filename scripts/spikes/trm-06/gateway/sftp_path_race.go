package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/crypto/ssh"
)

// Concurrent OPEN and member-owned atomic leaf/ancestor replacement through
// the installed SSH listener. No supervisor hooks or root mutation operation.
// Independent outside bytes/owner/mode assertions remain in the root campaign.
func sftpSynchronizedPathOpen(client *ssh.Client, request func(byte, uint32, []byte) ([]byte, error), openBody func(string) []byte, evidence ...string) error {
	if len(evidence) != 1 {
		return errors.New("SFTP path timing evidence required")
	}
	journal, err := os.OpenFile(filepath.Join(evidence[0], "sftp-path-races.jsonl"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer journal.Close()
	execute := func(text string) ([]byte, error) {
		session, err := client.NewSession()
		if err != nil {
			return nil, err
		}
		defer session.Close()
		body, err := session.CombinedOutput("set -e; " + text)
		if err == nil && string(body) != "replaced" {
			err = errors.New("SFTP path replacement acknowledgment missing")
		}
		return body, err
	}
	for _, ancestor := range []bool{false, true} {
		for round := uint32(0); round < 16; round++ {
			setup := "rm -f /workspace/trm06-sync-link /workspace/trm06-sync-original; printf workspace > /workspace/trm06-sync-link; printf replaced"
			path := "/workspace/trm06-sync-link"
			swap := "mv /workspace/trm06-sync-link /workspace/trm06-sync-original; ln -s /var/tmp/trm06-outside /workspace/trm06-sync-link; printf replaced"
			restore := "rm /workspace/trm06-sync-link; mv /workspace/trm06-sync-original /workspace/trm06-sync-link; printf replaced"
			if ancestor {
				setup = "mkdir -p /workspace/trm06-sync-parent; printf workspace > /workspace/trm06-sync-parent/trm06-outside; printf replaced"
				path = "/workspace/trm06-sync-parent/trm06-outside"
				swap = "mv /workspace/trm06-sync-parent /workspace/trm06-sync-original; ln -s /var/tmp /workspace/trm06-sync-parent; printf replaced"
				restore = "rm /workspace/trm06-sync-parent; mv /workspace/trm06-sync-original /workspace/trm06-sync-parent; printf replaced"
			}
			if _, err = execute(setup); err != nil {
				return err
			}
			id := uint32(4000) + round*10
			if ancestor {
				id += 1000
			}
			positive, positiveErr := request(3, id+7, openBody(path))
			var positiveHandle struct{ Handle string }
			if positiveErr != nil || len(positive) < 9 || positive[0] != 102 || ssh.Unmarshal(positive[5:], &positiveHandle) != nil || len(positiveHandle.Handle) == 0 || len(positiveHandle.Handle) > 1024 {
				return errors.Join(positiveErr, errors.New("SFTP synchronized path positive OPEN failed"))
			}
			positive, positiveErr = request(4, id+8, ssh.Marshal(positiveHandle))
			if positiveErr != nil || !sftpStatus(positive, 0) {
				return errors.Join(positiveErr, errors.New("SFTP synchronized path positive CLOSE failed"))
			}
			var reply []byte
			race := synchronizedCgroupRevoke(func() ([]byte, error) { return execute(swap) }, func() error {
				var openErr error
				reply, openErr = request(3, id, openBody(path))
				return openErr
			})
			if err = json.NewEncoder(journal).Encode(map[string]any{"ancestor": ancestor, "round": round, "released_utc": race.Released, "mutation": race.Mutation, "open": race.Revocation, "reply": reply}); err != nil {
				return err
			}
			if err = journal.Sync(); err != nil {
				return err
			}
			// No overlap is inconclusive, never a passing race control.
			if err = errors.Join(race.validateOverlap(), race.Mutation.err, race.Revocation.err); err != nil {
				return err
			}
			if err = validateRacedSFTPOpen(reply, id, request); err != nil {
				return err
			}
			post, postErr := request(3, id+3, openBody(path))
			if postErr != nil || !(sftpStatus(post, 3) || sftpStatus(post, 4)) {
				return errors.Join(postErr, errors.New("SFTP post-replacement OPEN did not refuse"))
			}
			if _, err = execute(restore); err != nil {
				return err
			}
			if len(reply) > 0 && reply[0] == 102 {
				if _, err = execute("test \"$(cat " + path + ")\" = synchronized-fixture; printf replaced"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func validateRacedSFTPOpen(reply []byte, id uint32, request func(byte, uint32, []byte) ([]byte, error)) error {
	if sftpStatus(reply, 2) || sftpStatus(reply, 3) || sftpStatus(reply, 4) {
		return nil
	}
	var handle struct{ Handle string }
	if len(reply) < 9 || reply[0] != 102 || ssh.Unmarshal(reply[5:], &handle) != nil || len(handle.Handle) == 0 || len(handle.Handle) > 1024 {
		return errors.New("ambiguous SFTP raced OPEN")
	}
	// A permitted OPEN holds its original workspace inode across the swap.
	written, err := request(6, id+1, ssh.Marshal(struct {
		Handle string
		Offset uint64
		Data   string
	}{handle.Handle, 0, "synchronized-fixture"}))
	closed, closeErr := request(4, id+2, ssh.Marshal(handle))
	if err != nil || closeErr != nil || !sftpStatus(written, 0) || !sftpStatus(closed, 0) {
		return errors.Join(err, closeErr, errors.New("SFTP raced held-handle WRITE/CLOSE failed"))
	}
	return nil
}
