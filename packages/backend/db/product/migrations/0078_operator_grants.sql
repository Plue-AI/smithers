-- Old/imported/automated grants retain empty attribution; operator commands
-- require actor and reason before accessing the database.
ALTER TABLE credit_grants ADD COLUMN actor text NOT NULL DEFAULT '';
ALTER TABLE credit_grants ADD COLUMN reason text NOT NULL DEFAULT '';

-- A comp is its own immutable audit receipt. It never impersonates a Stripe
-- subscription or issues invoice credit. One insert atomically grants and audits.
CREATE TABLE billing_plan_grants (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 owner_type text NOT NULL CHECK (owner_type = 'user'),
 owner_id bigint NOT NULL REFERENCES users(id),
 source_key text NOT NULL CHECK (btrim(source_key) <> ''),
 plan_key text NOT NULL CHECK (plan_key IN ('pro', 'max')),
 expires_at timestamptz NOT NULL,
 actor text NOT NULL CHECK (btrim(actor) <> ''),
 reason text NOT NULL CHECK (btrim(reason) <> ''),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (owner_type, owner_id, source_key)
);
CREATE INDEX billing_plan_grants_owner ON billing_plan_grants (owner_type, owner_id, id DESC);
