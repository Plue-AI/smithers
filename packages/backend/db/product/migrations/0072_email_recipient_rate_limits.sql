-- One hourly budget per normalized recipient, shared by all API replicas.
CREATE TABLE email_recipient_rate_limits (
    recipient TEXT PRIMARY KEY,
    count BIGINT NOT NULL CHECK (count > 0),
    reset_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX email_recipient_rate_limits_expiry ON email_recipient_rate_limits (reset_at);
