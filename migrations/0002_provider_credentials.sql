CREATE TABLE provider_credentials (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL
);
