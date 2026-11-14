-- Conversaciones por canal (websim = chat web simulado; whatsapp cuando esté conectado).
CREATE TABLE messages (
  id bigserial PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  channel text NOT NULL DEFAULT 'websim',
  -- 'comercio' o el id del cliente al que va dirigido
  thread text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  body text NOT NULL,
  -- botones / enlaces para el canal (confirmar, pagar, aprobar)
  actions jsonb,
  proposal_id text REFERENCES proposals(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_thread_idx ON messages (merchant_id, thread, id);
