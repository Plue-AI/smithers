-- Retain billing receipts independently of sandbox/owner deletion.
CREATE TABLE sandbox_egress_daily_usage (
    scope text NOT NULL,
    day date NOT NULL,
    bytes bigint NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    PRIMARY KEY (scope, day)
);
CREATE TABLE sandbox_egress_usage (
    id uuid PRIMARY KEY,
    sandbox_id text NOT NULL,
    billing_user_id bigint NOT NULL CHECK (billing_user_id >= 0),
    day date NOT NULL,
    requested_bytes bigint NOT NULL CHECK (requested_bytes > 0 AND requested_bytes <= 1048576),
    bytes bigint NOT NULL CHECK (bytes >= 0 AND bytes <= requested_bytes),
    quota_bytes bigint NOT NULL CHECK (quota_bytes >= -1),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sandbox_egress_usage_owner_day ON sandbox_egress_usage(billing_user_id, day);
CREATE INDEX sandbox_egress_usage_sandbox_day ON sandbox_egress_usage(sandbox_id, day);
