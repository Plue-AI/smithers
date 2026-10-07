package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"io"
)

// Literal SFTP v3 controls through the real SSH subsystem. Path operations are
// interpreted only by the fixed guest sftp-server after verified identity drop.
func sftpFixture(client *ssh.Client) error {
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
		if err != nil || !sftpStatus(reply, 3) {
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
		// Landlock REFER can return EXDEV for cross-boundary rename, represented
		// as SSH_FX_FAILURE by OpenSSH. All other mutations must deny permission.
		if err != nil || !(sftpStatus(reply, 3) || (fixture.kind == 18 && sftpStatus(reply, 4))) {
			return fmt.Errorf("SFTP mutation %d did not refuse", fixture.kind)
		}
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
