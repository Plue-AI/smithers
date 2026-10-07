-- Stack attention is retained on the existing aggregate, never a second table.
ALTER TABLE mythical_stacks ADD COLUMN attention jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE mythical_stacks ADD CONSTRAINT mythical_stack_attention_array CHECK (jsonb_typeof(attention) = 'array');
