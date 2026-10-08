package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"time"
)

// Preserve the exact invalid input and every observed reply, including partial
// headers/bodies on NO. One initial window may race the invalid input; repeated
// windows are not an unchanged session. Fixed deadlines and reply limits bound
// both the peer and retained evidence.
func validateMalformedSessionFrame(stream net.Conn, bad, evidence string, index int) (checkErr error) {
	stem := filepath.Join(evidence, fmt.Sprintf("invalid-frame-%03d", index))
	request := make([]byte, 4+len(bad))
	binary.BigEndian.PutUint32(request, uint32(len(bad)))
	copy(request[4:], bad)
	input, err := os.OpenFile(stem+"-request.raw", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	writeErr := writeAll(input, request)
	if err := errors.Join(writeErr, input.Close()); err != nil {
		return err
	}
	raw, err := os.OpenFile(stem+"-reply.raw", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() {
		checkErr = errors.Join(checkErr, raw.Close())
		result := map[string]any{"transport_closed": checkErr == nil, "error": ""}
		if checkErr != nil {
			result["error"] = checkErr.Error()
		}
		body, marshalErr := json.Marshal(result)
		if marshalErr != nil {
			checkErr = errors.Join(checkErr, marshalErr)
			return
		}
		checkErr = errors.Join(checkErr, os.WriteFile(stem+".json", body, 0600))
	}()
	if err := stream.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		return err
	}
	if err := writeAll(stream, request); err != nil {
		return err
	}
	reader := io.TeeReader(stream, raw)
	for replies := 0; ; replies++ {
		var length uint32
		if err := binary.Read(reader, binary.BigEndian, &length); err != nil {
			if err == io.EOF {
				return nil
			}
			return fmt.Errorf("invalid frame did not close transport: %w", err)
		}
		if replies > 0 || length == 0 || length > 65536 {
			return errors.New("invalid frame produced extra or unbounded replies")
		}
		body := make([]byte, length)
		if _, err := io.ReadFull(reader, body); err != nil {
			return err
		}
		var frame struct {
			Type  string `json:"type"`
			Bytes uint32 `json:"bytes"`
		}
		if decodeStrict(body, &frame) != nil || frame.Type != "window" || frame.Bytes != 262144 {
			return errors.New("invalid signal/credit changed the running fixture")
		}
	}
}
