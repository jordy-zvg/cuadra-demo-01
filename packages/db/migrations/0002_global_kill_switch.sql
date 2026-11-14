-- Freno de emergencia global (BRIEF §10.8). Una sola fila.
CREATE TABLE system_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  kill_switch boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_state (id) VALUES (true);
CREATE TRIGGER system_state_no_delete BEFORE DELETE ON system_state
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
