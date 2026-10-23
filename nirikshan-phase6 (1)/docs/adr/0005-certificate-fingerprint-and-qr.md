# ADR 0005: Certificate fingerprint and QR signature

**Problem.** The brief says the QR payload signs "the SHA-256 of the PDF". That is circular: the PDF carries the QR, and the QR would sign the PDF. A file cannot contain a hash of itself.

**Decision.**
1. `fingerprint = SHA-256(canonical JSON of the certificate content)`. Content is the fixed set of fields printed on the certificate (number, holder, instrument, capacity, class, permitted error, dates, sticker, issuing office, rule version). Keys are sorted, so the same content always gives the same bytes.
2. `sig = base64url(HMAC-SHA256(key, certNo + ":" + fingerprintHex))`, first 22 characters (about 132 bits). The QR link is `/v/{certNo with / as -}.{sig}`.
3. The PDF is rendered from the same content and stored. Its own hash is kept separately as `pdf_sha256` (integrity of the stored file), but it is not part of the signature.
4. Each certificate stores the `key_id` it was signed with. Keys derive from root keys with HKDF (label `cert-qr`) per key id, so a key can be rotated: new certificates use the active key, old ones keep verifying under theirs. The admin page shows key ids and how many certificates each signed, never key values.

**What the public check does.** It looks the number up in a small public read model (masked holder, category, capacity, dates, status, a public-safe reason). If a QR token is used, the signature is verified in constant time against the stored fingerprint. Unknown numbers and bad signatures return the same shape and take at least 150 ms. After 5 misses from one address in 10 minutes a human check is required. Lookups are logged with a hashed address only.

**What this is not.** It is a keyed code, not a public-key signature. Only the server can check it, so a printed certificate cannot be verified offline. It also is not a PAdES-signed PDF. A department that needs offline verification should move to an asymmetric key in a hardware key service and embed a PAdES signature. The `key_id` column and the fingerprint were chosen so that change does not alter certificate numbers or QR links.

**Staff check.** The certificate detail page recomputes the hash of the stored content and compares it with the stored fingerprint. A mismatch means the row was edited after issue.
