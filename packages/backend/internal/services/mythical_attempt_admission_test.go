package services

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTodoAttemptAdmissionTransaction(t *testing.T) {
	o, session := newTodoAdmission(t)
	peer := &todoRuntimeHost{digest: todoPinOne, source: o.landedMain()}
	pool, startWorker := o.runDispatcher(t, peer.resolver(t))
	o.service.SetTodoFlow(func(context.Context, int64, string) (string, error) { return todoPinOne, nil })
	item := o.fileTodo(session, "atomic-attempt")
	id := uuidString(item.ID)
	// Fail after the item write, at the real durable launch insertion. The
	// attempt, pin, snapshot and job must all roll back before any host work.
	_, err := pool.Exec(t.Context(), `CREATE FUNCTION refuse_attempt_launch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation='flow.runtime.launch' THEN RAISE EXCEPTION 'injected launch failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER refuse_attempt_launch BEFORE INSERT ON product_job_requests FOR EACH ROW EXECUTE FUNCTION refuse_attempt_launch()`)
	require.NoError(t, err)
	o.wake()
	refused := o.byID(id)
	require.Zero(t, refused.Attempt)
	require.False(t, refused.FlowDigest.Valid)
	require.Empty(t, mythicalChecksOf(refused).Attempts)
	require.Equal(t, 0, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
	require.Empty(t, peer.flows())
	_, err = pool.Exec(t.Context(), `DROP TRIGGER refuse_attempt_launch ON product_job_requests`)
	require.NoError(t, err)
	o.wake()
	started := o.byID(id)
	require.Equal(t, "starting", todoState(started))
	records := mythicalChecksOf(started).Attempts
	require.Len(t, records, 1, "admission must persist the attempt before the host responds")
	require.Equal(t, int32(1), records[0].Attempt)
	require.Equal(t, int64(1), records[0].Generation)
	require.Equal(t, todoPinOne, records[0].FlowDigest)
	require.Equal(t, o.landedMain(), records[0].SourceCommit)
	require.Empty(t, records[0].RunID, "a launch acknowledgment does not invent a runtime id")
	require.Empty(t, records[0].Outcome)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
	// Recovery can replay scheduling while the runtime is still absent.
	o.wake()
	require.Equal(t, records, mythicalChecksOf(o.byID(id)).Attempts)
	require.Equal(t, 1, fetchedCount(t, pool, `SELECT count(*) FROM product_job_requests WHERE operation='flow.runtime.launch'`))
	startWorker()
	require.Eventually(t, func() bool { return todoState(o.byID(id)) == "working" }, 10*time.Second, 10*time.Millisecond)
	attached := mythicalChecksOf(o.byID(id)).Attempts
	require.Len(t, attached, 1)
	require.Equal(t, "todo-run", attached[0].RunID)
	require.Equal(t, todoPinOne, attached[0].FlowDigest)
	require.Equal(t, records[0].SourceCommit, attached[0].SourceCommit)
	require.Empty(t, attached[0].Outcome)
	require.Equal(t, []string{"todo"}, peer.flows())
}
