package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
	"strconv"
	"strings"
)

// Literal SFTP v3 controls through the real SSH subsystem. Path operations are
// interpreted only by the fixed guest sftp-server after verified identity drop.
func sftpFixture(client *ssh.Client) error {
	return sftpBoundaryFixture(client, false)
}

func sftpBoundaryFixture(client *ssh.Client, race bool) error {
	session, err := client.NewSession()
	if err != nil {
		return err
	}
	defer session.Close()
	input, err := session.StdinPipe()
	if err != nil {
		return err
	}
	output, err := session.StdoutPipe()
	if err != nil {
		return err
	}
	if err = session.RequestSubsystem("sftp"); err != nil {
		return err
	}
	if err = writeAll(input, []byte{0, 0, 0, 5, 1, 0, 0, 0, 3}); err != nil {
		return err
	}
	reply, err := readSFTPPacket(output)
	if err != nil || len(reply) < 5 || reply[0] != 2 || binary.BigEndian.Uint32(reply[1:5]) != 3 {
		return errors.New("SFTP v3 negotiation failed")
	}
	request := func(kind byte, id uint32, body []byte) ([]byte, error) {
		packet := make([]byte, 5+len(body))
		packet[0] = kind
		binary.BigEndian.PutUint32(packet[1:5], id)
		copy(packet[5:], body)
		if err := binary.Write(input, binary.BigEndian, uint32(len(packet))); err != nil {
			return nil, err
		}
		if err := writeAll(input, packet); err != nil {
			return nil, err
		}
		reply, err := readSFTPPacket(output)
		if err != nil {
			return nil, err
		}
		if len(reply) < 5 || binary.BigEndian.Uint32(reply[1:5]) != id {
			return nil, errors.New("SFTP request order changed")
		}
		return reply, nil
	}
	openBody := func(path string) []byte {
		return ssh.Marshal(struct {
			Path         string
			Flags, Attrs uint32
		}{path, 26, 0})
	}
	reply, err = request(3, 1, openBody("/workspace/trm06-sftp.txt"))
	if err != nil || len(reply) < 9 || reply[0] != 102 {
		return errors.New("SFTP workspace open failed")
	}
	var handle struct{ Handle string }
	if ssh.Unmarshal(reply[5:], &handle) != nil || len(handle.Handle) == 0 || len(handle.Handle) > 1024 {
		return errors.New("invalid SFTP handle")
	}
	reply, err = request(6, 2, ssh.Marshal(struct {
		Handle string
		Offset uint64
		Data   string
	}{handle.Handle, 0, "sftp-fixture\x00"}))
	if err != nil || !sftpStatus(reply, 0) {
		return errors.New("SFTP workspace write failed")
	}
	reply, err = request(4, 3, ssh.Marshal(handle))
	if err != nil || !sftpStatus(reply, 0) {
		return errors.New("SFTP close failed")
	}
	for i, path := range []string{"/var/tmp/trm06-outside", "/workspace/trm06-escape", "/workspace/../var/tmp/trm06-outside", "/home/agent/trm06-private"} {
		reply, err = request(3, uint32(4+i), openBody(path))
		if err != nil || !(sftpStatus(reply, 3) || sftpStatus(reply, 4)) {
			return errors.New("SFTP outside/home write was not denied")
		}
	}
	// Mutating operations must also respect the dropped filesystem boundary.
	// Existing writable sentinel bytes are checked independently after revocation.
	for i, fixture := range []struct {
		kind byte
		body []byte
	}{
		{13, ssh.Marshal(struct{ Path string }{"/var/tmp/trm06-outside"})},
		{14, ssh.Marshal(struct {
			Path        string
			Flags, Mode uint32
		}{"/var/tmp/trm06-new-dir", 4, 0777})},
		{9, ssh.Marshal(struct {
			Path        string
			Flags, Mode uint32
		}{"/var/tmp/trm06-outside", 4, 0777})},
		{18, ssh.Marshal(struct{ Old, New string }{"/workspace/trm06-sftp.txt", "/var/tmp/trm06-outside"})},
	} {
		reply, err = request(fixture.kind, uint32(20+i), fixture.body)
		// OpenSSH maps read-only mount EROFS and cross-mount EXDEV to
		// SSH_FX_FAILURE; Landlock/DAC EACCES maps to permission denied.
		// Independently sampled sentinel bytes/owner/mode remain mandatory.
		if err != nil || !(sftpStatus(reply, 3) || sftpStatus(reply, 4)) {
			return fmt.Errorf("SFTP mutation %d did not refuse", fixture.kind)
		}
	}
	if race {
		return sftpPathRace(client, request, openBody)
	}
	return nil
}
func sftpStatus(packet []byte, code uint32) bool {
	return len(packet) >= 9 && packet[0] == 101 && binary.BigEndian.Uint32(packet[5:9]) == code
}
func readSFTPPacket(reader io.Reader) ([]byte, error) {
	var length uint32
	if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
		return nil, err
	}
	if length < 5 || length > 65536 {
		return nil, errors.New("invalid SFTP fixture reply length")
	}
	packet := make([]byte, length)
	_, err := io.ReadFull(reader, packet)
	return packet, err
}

// The installed root campaign runs this member-owned path replacement while
// SFTP opens/writes the same pathname. Kernel/sentinel observations, rather
// than a successful protocol exchange, decide whether confinement held.
func sftpPathRace(client *ssh.Client, request func(byte, uint32, []byte) ([]byte, error), openBody func(string) []byte) (result error) {
	racer, err := client.NewSession()
	if err != nil {
		return err
	}
	defer racer.Close()
	output, err := racer.StdoutPipe()
	if err != nil {
		return err
	}
	// All paths and script bytes are installed campaign literals. This executes
	// through the ordinary dropped SSH exec channel, never a root fixture.
	const command = `rm -f /workspace/trm06-race-stop /workspace/trm06-race-link /workspace/trm06-race-swap
n=0
printf ready
while [ ! -e /workspace/trm06-race-stop ] && [ "$n" -lt 10000 ]; do
 ln -s /var/tmp/trm06-outside /workspace/trm06-race-swap || exit 1
 mv -Tf /workspace/trm06-race-swap /workspace/trm06-race-link || exit 1
 n=$((n+1))
 rm -f /workspace/trm06-race-link || exit 1
 printf workspace > /workspace/trm06-race-swap || exit 1
 mv -Tf /workspace/trm06-race-swap /workspace/trm06-race-link || exit 1
done
printf '%s' "$n"`
	if err = racer.Start(command); err != nil {
		return err
	}
	defer func() {
		stop, err := client.NewSession()
		if err == nil {
			_, err = stop.CombinedOutput("touch /workspace/trm06-race-stop")
			stop.Close()
		}
		if err != nil {
			if result == nil {
				result = err
			}
			return
		}
		count, readErr := io.ReadAll(io.LimitReader(output, 32))
		waitErr := racer.Wait()
		cycles, parseErr := strconv.Atoi(strings.TrimSpace(string(count)))
		if result == nil && (readErr != nil || waitErr != nil || parseErr != nil || cycles < 1) {
			result = errors.New("SFTP path racer did not complete a replacement cycle")
		}
	}()
	ready := make([]byte, 5)
	if _, err = io.ReadFull(output, ready); err != nil || string(ready) != "ready" {
		return errors.New("SFTP path racer did not start")
	}
	opened, denied := 0, 0
	for i := uint32(0); i < 256; i++ {
		id := 100 + 3*i
		reply, err := request(3, id, openBody("/workspace/trm06-race-link"))
		if err != nil {
			return err
		}
		if sftpStatus(reply, 3) || sftpStatus(reply, 4) {
			denied++
			continue
		}
		if sftpStatus(reply, 2) {
			continue
		} // The pathname is briefly absent.
		if len(reply) < 9 || reply[0] != 102 {
			return errors.New("unexpected SFTP raced open result")
		}
		var handle struct{ Handle string }
		if ssh.Unmarshal(reply[5:], &handle) != nil || len(handle.Handle) == 0 || len(handle.Handle) > 1024 {
			return errors.New("invalid raced SFTP handle")
		}
		opened++
		reply, err = request(6, id+1, ssh.Marshal(struct {
			Handle string
			Offset uint64
			Data   string
		}{handle.Handle, 0, "race-canary"}))
		if err != nil || !sftpStatus(reply, 0) {
			return errors.New("SFTP held workspace handle lost write access")
		}
		reply, err = request(4, id+2, ssh.Marshal(handle))
		if err != nil || !sftpStatus(reply, 0) {
			return errors.New("SFTP raced handle close failed")
		}
	}
	if opened == 0 || denied == 0 {
		return errors.New("SFTP race did not observe both permitted and forbidden targets")
	}
	return nil
}
