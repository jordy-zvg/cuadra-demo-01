-- Cuentas del portal web (/login): celular + NIP de 4 dígitos. Son personas que usan la tienda
-- desde el navegador; no tocan merchant_users (que usa el guard para R02) ni las passkeys.
CREATE TABLE portal_accounts (
  id text PRIMARY KEY,
  merchant_id text NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  phone text NOT NULL,                       -- 10 dígitos, sin lada de país
  pin_hash text NOT NULL,                    -- scrypt, con sal; nunca el NIP
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, phone)
);

-- Sesiones: en la cookie va un token aleatorio; aquí solo su hash.
CREATE TABLE portal_sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_sessions_account_idx ON portal_sessions (account_id);
