-- Person confirmations share the existing approval store. Legacy run waits
-- retain their session identity and are not person-confirmation rows.
ALTER TABLE approvals ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE approvals
 ADD COLUMN member_id bigint REFERENCES users(id),
 ADD COLUMN credential_id text,
 ADD COLUMN command text,
 ADD COLUMN subject jsonb,
 ADD COLUMN revision text,
 ADD COLUMN generation bigint,
 ADD COLUMN reviewed_head_sha text,
 ADD COLUMN decision_credential text,
 ADD COLUMN decision_key text;
ALTER TABLE approvals ADD CONSTRAINT approvals_confirmation_binding CHECK (
 member_id IS NULL OR (
  kind IN ('one_click', 'review_merge') AND credential_id IS NOT NULL
  AND command IS NOT NULL AND subject IS NOT NULL
  AND jsonb_typeof(subject) = 'object' AND revision IS NOT NULL
  AND expires_at IS NOT NULL
  AND (kind <> 'review_merge' OR (generation IS NOT NULL AND reviewed_head_sha IS NOT NULL))
 )
);
CREATE INDEX approvals_member_created ON approvals(member_id, created_at DESC) WHERE member_id IS NOT NULL;
CREATE UNIQUE INDEX approvals_decision_press ON approvals(decision_credential, decision_key) WHERE decision_key IS NOT NULL;
