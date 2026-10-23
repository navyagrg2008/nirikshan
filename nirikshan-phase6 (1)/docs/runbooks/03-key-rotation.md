# 3. Key rotation

## How keys work here
`ROOT_KEYS` is a JSON object `{ "keyId": "base64-32-bytes", ... }`. **The first entry is the active key**: it encrypts new data and signs new certificate QR codes. Every stored value remembers which key it used, so older values keep opening as long as the old key stays in the object.

## Planned rotation (yearly)
1. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. Put the new key **first**, keep every old key after it: `{"k2":"<new>","k1":"<old>"}`.
3. Store in the secrets manager, restart the API (one at a time if more than one).
4. Check: register a test owner, view the profile; open an old certificate and validate it publicly (old QR codes must still verify); sign in as an existing user.
5. Keep old keys. **Do not delete an old key** while any data may still use it. There is no re-encryption tool yet, so old keys stay for the life of the data (deviation, see PHASE6.md).

## If a key may have leaked
1. Treat as an incident (runbook 4). Rotate as above immediately so new data is protected.
2. Data written under the leaked key stays readable by whoever holds it plus the database. Assess with the office head and the data protection contact whether notification is required.
3. Rotate the other secrets that were next to it: CAPTCHA secret, SMTP/SMS credentials, database password, storage keys.
4. Force everyone out: delete the Redis session keys (`redis-cli --scan --pattern "sess:*"`) or restart Redis. Staff will sign in again with a code.

## Never
- Put real keys in the repo, chat, tickets or `.env` files on shared machines.
- Use the development key (`dev-1`) anywhere real. The API refuses to start with it in production.
