# Database Design

Source of truth: `db/schema.sql` (PostgreSQL 16 + PostGIS). This document explains it.

## 1. Principles

- UUID primary keys (app generates v7 for index locality), `created_at` / `updated_at`, `version` column for optimistic locking on mutable business rows.
- No hard deletes in business tables: state lives in a status column.
- **No payment, fee, invoice, receipt or settlement tables.** Nothing in the schema carries money.
- Server-computed values (`error_value`, `error_pct`, `verdict`, `valid_till`, `due_date`) are columns the API writes; no client value is ever stored in them.
- PII is encrypted per field (AES-256-GCM, envelope keys from KMS) in `*_enc` columns. Searchable fields have a blind index (`*_bidx`, HMAC) so lookups work without plaintext.
- Public data comes only from `public_certificate_index`, which holds masked text and no PII.

## 2. Entity-relationship overview

```mermaid
erDiagram
    users ||--o{ user_roles : has
    roles ||--o{ user_roles : grants
    users ||--|| user_profiles : has
    users ||--o{ businesses : owns
    users ||--o{ user_area_scopes : scoped_to
    areas ||--o{ user_area_scopes : includes
    areas ||--o{ areas : parent_of
    businesses }o--|| areas : located_in
    businesses ||--o{ instruments : holds
    instruments }o--|| categories : of
    instruments }o--|| capacity_bands : in
    instruments }o--|| accuracy_classes : class
    instruments ||--o{ applications : verified_by
    applications }o--|| rule_sets : pinned_to
    applications ||--o{ application_documents : has
    applications ||--o{ case_status_history : logs
    applications ||--o{ inspection_visits : has
    inspection_visits ||--o{ checklist_responses : records
    inspection_visits ||--o{ test_measurements : records
    inspection_visits ||--o{ evidence : attaches
    inspection_visits ||--o| inspection_drafts : autosaves
    applications ||--o{ decisions : decided_by
    applications ||--o| certificates : yields
    certificates ||--o{ certificate_status_history : logs
    certificates ||--|| public_certificate_index : projects_to
    rule_sets ||--o{ mpe_rules : contains
    rule_sets ||--o{ interval_rules : contains
    rule_sets ||--o{ workflow_slas : contains
    users ||--o{ audit_events : acts
    users ||--o{ data_subject_requests : raises
```

## 3. Table dictionary

### Identity and access
| Table | Purpose | Key points |
|---|---|---|
| `users` | One row per Keycloak identity | `keycloak_sub` unique; mobile/email encrypted + blind index; `account_status` lifecycle |
| `roles`, `permissions`, `role_permissions` | RBAC | Role codes: OWNER, TRADER, INSPECTOR, OFFICER, SENIOR_OFFICER, ADMIN |
| `user_roles` | Role assignment | |
| `user_area_scopes` | Jurisdiction for officers and inspectors | Child areas included by query |
| `user_profiles` | Encrypted name, DOB, address | ID proof kept as type + last 4 only |
| `consents` | Versioned consent records | `withdrawn_at` supports withdrawal |
| `businesses` | Owner/trader firm | Encrypted firm name, licence, GSTIN, address, premises geo; `firm_name_masked` for public views |
| `account_reviews` | Officer approval history | |
| `otp_challenges` | OTP state | Code hashed, attempts capped at 5 by CHECK |

### Master data
`areas` (Division > Zone > Circle > Ward with PostGIS polygon), `categories`, `sub_categories`, `accuracy_classes`, `capacity_bands`,
`document_types`, `reason_codes` (with `public_safe` flag), `holiday_calendar`, `checklist_templates`, `notification_templates`, `notices`.

### Rules (versioned, effective-dated)
| Table | Purpose |
|---|---|
| `rule_sets` | One version of the whole rulebook; status DRAFT > IN_REVIEW > PUBLISHED > RETIRED; reviewer must differ from author |
| `mpe_rules` | Permissible error per category + capacity band + class + direction |
| `interval_rules` | Months of validity, marginal-pass months, grace days, application window |
| `workflow_slas` | Max hours per workflow step |

Database-level guarantees:
- `EXCLUDE USING gist (daterange(effective_from, effective_to) WITH &&) WHERE status = 'PUBLISHED'` makes overlapping published ranges impossible.
- Trigger blocks update/delete of rules under a PUBLISHED rule set (corrections = new version).
- `applications.rule_set_id` pins the version at application time; `resolveRules(caseId)` reads that, never "latest".

### Instruments and applications
| Table | Purpose | Key points |
|---|---|---|
| `instruments` | Registered instrument | Partial unique index on `(serial, make, category)` for non-deregistered rows without officer override; GiST on location; btree on `(status, area_id, created_at)` |
| `instrument_ownership_history`, `ownership_transfers` | Ownership trail | |
| `instrument_drafts` | Wizard autosave | Encrypted payload, 7-day expiry |
| `applications` | The case | **Partial unique index: one open application per instrument** (terminal: REJECTED, CANCELLED, APPLICATION_EXPIRED, CERTIFICATE_ISSUED) |
| `application_documents` | Uploaded documents | Random object key, scan status, review status, version |
| `case_status_history` | Every transition | Written in the same transaction as the change and the audit event |

### Scheduling and inspection
`inspector_skills`, `inspector_availability` (range type, GiST), `inspection_visits` (window, `score_breakdown` jsonb, geofence fields),
`checklist_responses`, `test_measurements` (server-computed columns), `evidence` (geo-tagged), `inspection_drafts` (private, 7 days).

### Decisions and certificates
| Table | Purpose | Key points |
|---|---|---|
| `decisions` | Approve / reject / refer | CHECK: reject needs reason code and remarks; second approver differs from first; `reauth_at` stored |
| `cert_sequences` | Counter per division + year | Increment inside the issue transaction with row lock; numbers never reused |
| `certificates` | The certificate | `cert_no` unique; trigger blocks changes except status; `fingerprint` SHA-256; `key_id`; `replaces_certificate_id` |
| `certificate_status_history` | Status trail | `public_reason` is the only text exposed publicly |
| `public_certificate_index` | Public read model | Masked holder, ward/zone, no PII; updated in the same transaction |
| `public_stats_aggregate`, `public_lookup_log` | Stats and lookup log | Log holds hashed IP only, retained 90 days |

### Lifecycle and communication
`service_jobs`, `grievances`, `tamper_reports`, `enforcement_drives` + `enforcement_drive_items`, `notification_preferences`,
`in_app_notifications`, `message_log` (masked + hashed recipient, dedupe key), `data_subject_requests`, `idempotency_keys`.

### Audit
`audit_events`: append-only and hash-chained.
- `hash = SHA-256(prev_hash || canonical JSON of the event)`, computed by a BEFORE INSERT trigger under an advisory lock so concurrent writers cannot fork the chain.
- Triggers reject UPDATE, DELETE and TRUNCATE. The app DB role has no UPDATE/DELETE grant.
- Nightly job recomputes the chain; admin has a "Verify chain" button.
- `details` never holds PII or secrets.

## 4. Encryption design

| Data | Method |
|---|---|
| Mobile, email | AES-256-GCM per field + HMAC blind index |
| Name, DOB, address, firm, licence, GSTIN, premises geo | AES-256-GCM per field (no index; searched via other keys) |
| ID proof | Document in private bucket; DB keeps type + last 4 only |
| Drafts (instrument and inspection) | Whole payload encrypted |
| Certificates PDFs, uploads | S3 SSE-KMS, private, pre-signed URLs <= 5 min |
| Whole DB, Redis, backups | Encrypted at rest (KMS) |

Envelope scheme: a data key is generated per record by KMS, used with a fresh 96-bit nonce, stored as `key_id | wrapped_key | nonce | ciphertext | tag`.
Locally a dev KMS shim implements the same interface.

## 5. Row-Level Security

Per transaction the API runs `SET LOCAL app.user_id`, `app.role`, `app.business_ids`, `app.area_ids`. Policies in `schema.sql`:

| Table | Owner/Trader | Inspector | Officer / Senior | Admin |
|---|---|---|---|---|
| `instruments` | own business (or on-behalf) | none | own areas | all |
| `applications` | own business | only visits assigned and open | own areas | all |
| `inspection_visits` | none | own visits | visits whose application is in own areas | all |

Phase 2 extends RLS to every table that holds business data (`application_documents`, `evidence`, `certificates`, etc.) as those tables get real code.
The API still filters in queries; RLS is the safety net, and the API role has no BYPASSRLS.

## 6. Indexing strategy

- `(status, area_id, created_at)` on `instruments` and `applications` for queues and lists.
- GiST on `areas.boundary`, `instruments.location`, availability and visit time ranges.
- Blind-index unique on mobile and email.
- Partial unique indexes for the two business invariants (one open application per instrument; no duplicate active instrument).
- `certificates (status, valid_till)` for the daily renewal and expiry scans.

## 7. Retention

| Data | Retention |
|---|---|
| Drafts | 7 days |
| OTP challenges | minutes (purged hourly) |
| Public lookup log | 90 days |
| Certificates, case history, audit | statutory period (to be confirmed with department) |
| Erasure requests | honoured except where law requires retention; user told which parts and why |

## 8. Migration plan

Phase 2 converts `schema.sql` into forward-only Prisma migrations plus raw SQL migrations for what Prisma cannot express
(exclusion constraint, partial indexes, RLS, triggers, PostGIS). Every migration is reviewed; no down-migrations in production.
