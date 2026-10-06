-- Shared product-operation admission and delivery. These rows queue external
-- effects; they do not describe a Flow graph or replace the canonical
-- TypeScript Flow/Control journal.
CREATE TABLE product_job_streams (
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    head BIGINT NOT NULL DEFAULT 0 CHECK (head >= 0),
    retention_floor BIGINT NOT NULL DEFAULT 1 CHECK (retention_floor > 0),
    PRIMARY KEY (tenant_id, principal_id),
    CHECK (tenant_id <> '' AND principal_id <> ''),
    CHECK (retention_floor <= head + 1)
);

CREATE TABLE product_job_requests (
    id UUID PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_id TEXT NOT NULL,
    payload_fingerprint BYTEA NOT NULL CHECK (octet_length(payload_fingerprint) = 32),
    payload JSONB NOT NULL,
    authorization_context JSONB NOT NULL CHECK (jsonb_typeof(authorization_context) = 'object'),
    state TEXT NOT NULL CHECK (state IN (
        'accepted', 'dispatching', 'running', 'waiting',
        'completed', 'failed', 'cancelled', 'uncertain'
    )),
    request_receipt JSONB NOT NULL CHECK (jsonb_typeof(request_receipt) = 'object'),
    terminal_receipt JSONB CHECK (terminal_receipt IS NULL OR jsonb_typeof(terminal_receipt) = 'object'),
    cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
    cancellation_requested_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id, principal_id, operation, request_id),
    UNIQUE (id, tenant_id, principal_id),
    CHECK (tenant_id <> '' AND principal_id <> '' AND operation <> '' AND request_id <> ''),
    CHECK ((cancellation_requested AND cancellation_requested_at IS NOT NULL)
        OR (NOT cancellation_requested AND cancellation_requested_at IS NULL)),
    CHECK ((state IN ('completed', 'failed', 'cancelled', 'uncertain')) = (terminal_receipt IS NOT NULL))
);

CREATE INDEX product_job_requests_owner_created
    ON product_job_requests (tenant_id, principal_id, created_at, id);

CREATE TABLE product_job_dispatches (
    operation_id UUID PRIMARY KEY REFERENCES product_job_requests(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'claimed', 'done', 'stopped')),
    effect_policy TEXT NOT NULL CHECK (effect_policy IN ('idempotent', 'reconcile', 'unsafe')),
    effect_key TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    external_attempt INTEGER NOT NULL DEFAULT 1 CHECK (external_attempt > 0),
    generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
    claim_token UUID,
    worker_id TEXT,
    claimed_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    external_started_at TIMESTAMPTZ,
    external_receipt JSONB CHECK (external_receipt IS NULL OR jsonb_typeof(external_receipt) = 'object'),
    reconcile_required BOOLEAN NOT NULL DEFAULT FALSE,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_error TEXT NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK (effect_key <> ''),
    CHECK (
        (status = 'claimed' AND claim_token IS NOT NULL AND worker_id IS NOT NULL
            AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR
        (status <> 'claimed' AND claim_token IS NULL AND worker_id IS NULL
            AND claimed_at IS NULL AND lease_expires_at IS NULL)
    )
);

CREATE INDEX product_job_dispatches_ready
    ON product_job_dispatches (next_attempt_at, operation_id)
    WHERE status = 'ready';
CREATE INDEX product_job_dispatches_expired
    ON product_job_dispatches (lease_expires_at, operation_id)
    WHERE status = 'claimed';

CREATE TABLE product_job_events (
    tenant_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    event_id UUID NOT NULL UNIQUE,
    operation_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    state TEXT NOT NULL,
    data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, principal_id, sequence),
    FOREIGN KEY (tenant_id, principal_id)
        REFERENCES product_job_streams(tenant_id, principal_id) ON DELETE CASCADE,
    FOREIGN KEY (operation_id, tenant_id, principal_id)
        REFERENCES product_job_requests(id, tenant_id, principal_id) ON DELETE RESTRICT,
    CHECK (tenant_id <> '' AND principal_id <> '' AND event_type <> '' AND state <> '')
);

CREATE INDEX product_job_events_operation
    ON product_job_events (operation_id, sequence);

-- Order the existing TODO source facts across items. Existing per-item cursors
-- and persisted facts remain unchanged; no transport event/cursor table.
ALTER TABLE product_job_events ADD COLUMN repository_sequence bigint;
ALTER TABLE product_job_events ADD CONSTRAINT todo_repository_sequence_positive CHECK(repository_sequence IS NULL OR repository_sequence>0);
CREATE UNIQUE INDEX product_job_events_repository_order ON product_job_events(tenant_id,repository_sequence) WHERE repository_sequence IS NOT NULL;
