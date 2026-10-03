-- repository_id = 0 names install-wide topics; repository topics carry their id.
-- Projection events (spec §3, §3.1, §3.3, §7.2; T-STK-01). Every mutation
-- that changes a card writes its row change and one projection_events row
-- per affected topic in the same transaction, then NOTIFY live, '<topic>'
-- (queued by the writer, delivered at commit). The live channel (T-COL-02)
-- serves a topic's rows to subscribers by cursor = seq.
--
-- seq is per topic, gap-free and in commit order: a writer takes the next
-- value by updating the topic's projection_topics row, which it holds locked
-- until it commits, so no later seq of a topic can commit before an earlier
-- one. A rolled-back transaction gives its seq back.
CREATE TABLE projection_topics (
    repository_id bigint NOT NULL DEFAULT 0 CHECK (repository_id >= 0),
    topic text NOT NULL CHECK (topic <> ''),
    last_seq bigint NOT NULL CHECK (last_seq > 0),
    PRIMARY KEY (repository_id, topic)
);

CREATE TABLE projection_events (
    repository_id bigint NOT NULL DEFAULT 0 CHECK (repository_id >= 0),
    topic text NOT NULL CHECK (topic <> ''),
    seq bigint NOT NULL CHECK (seq > 0),
    at timestamptz NOT NULL DEFAULT now(),
    payload jsonb NOT NULL,
    PRIMARY KEY (repository_id, topic, seq)
);

-- Retention (§3.3) deletes a topic's rows older than 24 h beyond its newest
-- 10,000; a cursor older than the oldest kept row gets a fresh snapshot.
CREATE INDEX projection_events_at_idx ON projection_events (at);
