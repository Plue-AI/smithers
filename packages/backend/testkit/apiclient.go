package testkit

import (
	"net/http"
	"net/http/httptest"

	"github.com/smithersai/smithers/packages/backend/apiclient"
)

// handlerDoer serves each request in process through a handler, so a test
// drives a router with the generated client and no listener.
type handlerDoer struct{ handler http.Handler }

func (d handlerDoer) Do(request *http.Request) (*http.Response, error) {
	recorder := httptest.NewRecorder()
	d.handler.ServeHTTP(recorder, request)
	response := recorder.Result()
	response.Request = request
	return response, nil
}

// APIClient is the generated product API client served by handler in process.
// header is sent with every request, for example an Authorization value.
func APIClient(handler http.Handler, header http.Header) *apiclient.Client {
	return &apiclient.Client{BaseURL: "http://smithers.test", HTTPClient: handlerDoer{handler: handler}, Header: header}
}
