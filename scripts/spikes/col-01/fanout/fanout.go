// Package fanout owns no document mirror: every update and initialization
// passes through the one persistent stream to the real Yrs guest.
package fanout

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/smithersai/smithers/packages/backend/col01/measure"
)

type Message struct {
	Kind            string `json:"kind"`
	Seq             uint64 `json:"seq,omitempty"`
	Update          string `json:"update,omitempty"`
	Saves           uint64 `json:"saves,omitempty"`
	SaveNS          uint64 `json:"save_ns,omitempty"`
	HostIn          string `json:"host_in,omitempty"`
	HostOut         string `json:"host_out,omitempty"`
	HostVMNS        string `json:"host_vm_ns,omitempty"`
	HostInElapsedNS string `json:"host_in_elapsed_ns,omitempty"`
}

type Server struct {
	ctx         context.Context
	guest       net.Conn
	mu          sync.Mutex
	clients     map[*websocket.Conn]bool
	room        string
	epoch       time.Time
	readDisk    func(context.Context) ([]byte, error)
	environment any
	script      string
}

func New(ctx context.Context, guest net.Conn, readDisk func(context.Context) ([]byte, error), environment any, script string) *Server {
	return &Server{ctx: ctx, guest: guest, clients: map[*websocket.Conn]bool{}, epoch: time.Now(), readDisk: readDisk, environment: environment, script: script}
}

// exchange requires mu; framing and request/reply ordering belong to one host.
func (s *Server) exchange(request Message) (Message, error) {
	var response Message
	bytes, err := json.Marshal(request)
	if err != nil {
		return response, err
	}
	if err = s.guest.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		return response, err
	}
	if err = measure.WriteFrame(s.guest, bytes); err != nil {
		return response, err
	}
	bytes, err = measure.ReadFrame(s.guest)
	if err != nil {
		return response, err
	}
	err = json.Unmarshal(bytes, &response)
	if err == nil && request.Kind == "update" && (response.Kind != "update" || response.Seq != request.Seq || response.Update != request.Update) {
		err = fmt.Errorf("guest response mismatch for %d", request.Seq)
	}
	return response, err
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><meta charset="utf-8"><script src="/spike.js"></script></html>`)
	})
	mux.HandleFunc("/spike.js", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, s.script) })
	mux.HandleFunc("/env", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.environment)
	})
	mux.HandleFunc("/clock", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"host_ns": strconv.FormatInt(time.Since(s.epoch).Nanoseconds(), 10)})
	})
	mux.HandleFunc("/disk", func(w http.ResponseWriter, r *http.Request) {
		bytes, err := s.readDisk(r.Context())
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = w.Write(bytes)
	})
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		result, err := s.exchange(Message{Kind: "stats"})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(result)
	})
	mux.HandleFunc("/reset", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			http.Error(w, "POST required", 405)
			return
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if len(s.clients) != 0 {
			http.Error(w, "close browser pages before resetting", 409)
			return
		}
		_, err := s.exchange(Message{Kind: "reset"})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		s.room = r.URL.Query().Get("room")
		w.WriteHeader(204)
	})
	mux.HandleFunc("/ws", s.websocket)
	return mux
}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	// This unauthenticated spike binds only the explicitly selected LAN +
	// loopback addresses; product authentication/protocol are out of scope.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(measure.MaxFrame)
	defer conn.CloseNow()
	s.mu.Lock()
	if r.URL.Query().Get("room") != s.room {
		s.mu.Unlock()
		return
	}
	initial, err := s.exchange(Message{Kind: "snapshot"})
	if err == nil {
		err = s.send(conn, initial)
	}
	if err == nil {
		s.clients[conn] = true
	}
	s.mu.Unlock()
	if err != nil {
		return
	}
	defer func() { s.mu.Lock(); delete(s.clients, conn); s.mu.Unlock() }()
	for {
		kind, bytes, err := conn.Read(s.ctx)
		if err != nil {
			return
		}
		hostIn := time.Since(s.epoch).Nanoseconds()
		if kind != websocket.MessageText {
			return
		}
		var request Message
		if json.Unmarshal(bytes, &request) != nil || request.Kind != "update" || request.Seq == 0 {
			return
		}
		s.mu.Lock()
		start := time.Now()
		response, err := s.exchange(request)
		vmNS := time.Since(start).Nanoseconds()
		if err != nil {
			s.mu.Unlock()
			fmt.Fprintln(os.Stderr, "guest update:", err)
			return
		}
		response.HostIn = strconv.FormatInt(hostIn, 10)
		response.HostInElapsedNS = response.HostIn
		response.HostVMNS = strconv.FormatInt(vmNS, 10)
		for sink := range s.clients {
			response.HostOut = strconv.FormatInt(time.Since(s.epoch).Nanoseconds(), 10)
			if err = s.send(sink, response); err != nil {
				sink.CloseNow()
				delete(s.clients, sink)
			}
		}
		s.mu.Unlock()
	}
}

func (s *Server) send(conn *websocket.Conn, message Message) error {
	bytes, err := json.Marshal(message)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, bytes)
}
