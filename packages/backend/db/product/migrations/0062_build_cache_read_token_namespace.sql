ALTER TABLE build_cache_read_tokens
ADD COLUMN namespace_prefix text NOT NULL DEFAULT '';
