-- Bloqueos del guard y de la política (para el panel y el red team).
CREATE TABLE guard_blocks (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  kind text NOT NULL,
  provenance text NOT NULL,
  reasons jsonb NOT NULL,
  source text NOT NULL DEFAULT 'chat',   -- 'chat' o 'red_team'
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guard_blocks_idx ON guard_blocks (merchant_id, id);
