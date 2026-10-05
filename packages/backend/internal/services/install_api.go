package services

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/smithersai/smithers/packages/backend/internal/db"
	"github.com/smithersai/smithers/packages/backend/internal/identity"
	"github.com/smithersai/smithers/packages/backend/internal/middleware"
)

var (
	// ErrAPIForbidden: the turn's credential no longer acts for its author on
	// the install's API.
	ErrAPIForbidden = errors.New("the turn's credential no longer reads the install API")
	// ErrAPICallRefused: a host-run command asked for anything but a read of
	// one install API route.
	ErrAPICallRefused = errors.New("a host-run command reads one install API route")
)

// APIAnswer is one install route's answer to a host-run command: its status
// and its JSON body, or null when the route answered no JSON.
type APIAnswer struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// maxAPIAnswerBytes bounds the body one route may answer a command with; a
// longer answer is no answer.
const maxAPIAnswerBytes = 4 << 20

// InstallAPI serves the install API reads an app-agent turn's host-run
// commands make (spec §15.1.4), with the authority of the credential that
// admitted the turn, resolved again at each call: it must still authenticate
// the turn's author, as an account that may sign in, inside the
// installation's member boundary. The read then runs through the install's
// own route, whose authorization applies to that credential as it does to a
// request from the person's browser; no route is reached any other way.
//
// A read here is not attributed to Smithers and passes no API rate limit:
// the producer callback is an internal route, outside the public /api
// group's GlobalAPIRateLimit. ReloadCredential still reads the credential
// from the database on every call, so revoking it stops the next read.
//
// T-ACC-04's delegated(via=smithers) turn credential replaces this: the host
// will call the public API with it directly, attributed and rate limited as
// the person, and this callback goes.
type InstallAPI struct {
	Pool *pgxpool.Pool
	// Members is the installation's member boundary, the one AuthLoader
	// applies to every credential; without one nothing is read.
	Members identity.MemberAuthorizer
	// Routes are the install's API routes a command may read, mounted as
	// the public API mounts them.
	Routes http.Handler
}

// Author names the person a turn's commands read the install API as, by
// login, when the credential that admitted the turn is that person's browser
// session now. The TODO routes admit a person's session and refuse every
// token, so a turn admitted another way is offered none of their commands.
func (a InstallAPI) Author(ctx context.Context, credential middleware.Credential, userID int64) (string, error) {
	info, err := turnAuthor(ctx, db.New(a.Pool), a.Members, credential, userID, func(info *middleware.AuthInfo) bool {
		return !info.IsTokenAuth && info.SessionHash != ""
	})
	if errors.Is(err, errNotTheAuthor) {
		return "", ErrAPIForbidden
	}
	if err != nil {
		return "", err
	}
	return info.User.Username, nil
}

// Call serves one GET of an install API route as the turn's credential, and
// answers what the route answered. Only reads reach a route here: every
// write a command asks for is the person's to confirm.
func (a InstallAPI) Call(ctx context.Context, credential middleware.Credential, userID int64, method, path string) (APIAnswer, error) {
	if method != http.MethodGet || !strings.HasPrefix(path, "/api/") || a.Routes == nil {
		return APIAnswer{}, ErrAPICallRefused
	}
	info, err := turnAuthor(ctx, db.New(a.Pool), a.Members, credential, userID, func(*middleware.AuthInfo) bool { return true })
	if errors.Is(err, errNotTheAuthor) {
		return APIAnswer{}, ErrAPIForbidden
	}
	if err != nil {
		return APIAnswer{}, err
	}
	// The read is a request of its own. It ends with the caller, but carries
	// none of the caller's values: a producer callback is itself a routed
	// request, and its route must not decide this one's.
	own, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer context.AfterFunc(ctx, cancel)()
	request, err := http.NewRequestWithContext(middleware.ContextWithAuthInfo(own, info), http.MethodGet, path, nil)
	if err != nil {
		return APIAnswer{}, ErrAPICallRefused
	}
	answer := &routeAnswer{header: http.Header{}, status: http.StatusOK}
	a.Routes.ServeHTTP(answer, request)
	body := answer.body.Bytes()
	if answer.overflow || !json.Valid(body) {
		body = []byte("null")
	}
	return APIAnswer{Status: answer.status, Body: bytes.TrimSpace(body)}, nil
}

// routeAnswer records one route's answer, bounded.
type routeAnswer struct {
	header   http.Header
	status   int
	wrote    bool
	body     bytes.Buffer
	overflow bool
}

func (r *routeAnswer) Header() http.Header { return r.header }

func (r *routeAnswer) WriteHeader(status int) {
	if !r.wrote {
		r.status, r.wrote = status, true
	}
}

func (r *routeAnswer) Write(data []byte) (int, error) {
	r.WriteHeader(http.StatusOK)
	if r.body.Len()+len(data) > maxAPIAnswerBytes {
		r.overflow = true
		return len(data), nil
	}
	return r.body.Write(data)
}
