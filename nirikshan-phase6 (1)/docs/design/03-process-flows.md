# Process Flows

All diagrams are Mermaid; they render in GitHub, VS Code (Markdown Preview Mermaid), and most doc tools.

## 1. State machines

The brief's single state list is split into three lifecycles.

### 1.1 Application (case) status

```mermaid
stateDiagram-v2
    [*] --> APPLIED: owner applies
    APPLIED --> DOCUMENT_CHECKED: officer completes document check
    APPLIED --> CANCELLED: owner cancels
    APPLIED --> APPLICATION_EXPIRED: sweeper (no action in window)
    DOCUMENT_CHECKED --> SCHEDULED: assign (system or officer)
    SCHEDULED --> SCHEDULED: reschedule (reason, audit)
    SCHEDULED --> INSPECTION_IN_PROGRESS: inspector starts visit
    SCHEDULED --> FAILED_ATTEMPT: owner no-show
    FAILED_ATTEMPT --> SCHEDULED: rescheduled
    INSPECTION_IN_PROGRESS --> INSPECTED: inspector submits
    INSPECTED --> APPROVED: officer approves (reauth)
    INSPECTED --> REJECTED: officer rejects (reason, reauth)
    INSPECTED --> REFERRED: officer refers
    INSPECTED --> SCHEDULED: send for re-inspection (new visit)
    REFERRED --> APPROVED: senior approves
    REFERRED --> REJECTED: senior rejects
    APPROVED --> CERTIFICATE_ISSUED: issue
    REJECTED --> [*]: owner may reapply as NEW case linked to old
    CERTIFICATE_ISSUED --> [*]
    CANCELLED --> [*]
    APPLICATION_EXPIRED --> [*]
```

Terminal statuses (excluded from the "one open application per instrument" index): `REJECTED`, `CANCELLED`, `APPLICATION_EXPIRED`, `CERTIFICATE_ISSUED`.

Transition table (implemented in `packages/shared`, enforced in the `applications` service):

| From | Action | To | Roles | Guard | Side effects |
|---|---|---|---|---|---|
| APPLIED | documentCheckComplete | DOCUMENT_CHECKED | officer | all required documents accepted | notify owner, trigger scheduler |
| APPLIED | cancel | CANCELLED | owner | only while APPLIED | notify officer |
| DOCUMENT_CHECKED | assign | SCHEDULED | system, officer | inspector in jurisdiction, capacity, skill | store score breakdown, notify owner + inspector |
| SCHEDULED | reschedule | SCHEDULED | officer, system | min notice; reason | audit, notify |
| SCHEDULED | startVisit | INSPECTION_IN_PROGRESS | inspector | assigned, within window | create visit record |
| SCHEDULED | markNoShow | FAILED_ATTEMPT | officer, system | window passed, owner absent | release slot, notify |
| INSPECTION_IN_PROGRESS | submit | INSPECTED | inspector | evidence complete, server verdicts computed | generate test sheet PDF, notify officer |
| INSPECTED | approve | APPROVED | officer, senior | reauth; documents, data, MPE, evidence all OK | compute validity |
| INSPECTED | reject | REJECTED | officer, senior | reauth; reason code + remarks | notify owner with next steps |
| INSPECTED | refer | REFERRED | officer | senior exists in area | notify senior |
| INSPECTED | reinspect | SCHEDULED | officer | reason | new visit, original sheet kept |
| APPROVED | issue | CERTIFICATE_ISSUED | system, officer | none | number, PDF, fingerprint, public index (same transaction) |

Every transition writes `case_status_history` and `audit_events` in the same DB transaction. Illegal transitions return 409.

### 1.2 Instrument lifecycle

```mermaid
stateDiagram-v2
    [*] --> REGISTERED: owner registers
    REGISTERED --> ACTIVE: first certificate issued
    ACTIVE --> DUE_FOR_RENEWAL: renewal scan (<= 60 days left)
    DUE_FOR_RENEWAL --> ACTIVE: renewed certificate issued
    DUE_FOR_RENEWAL --> EXPIRED: validity ends
    ACTIVE --> EXPIRED: validity ends
    EXPIRED --> ACTIVE: new certificate issued
    REGISTERED --> DEREGISTERED: officer approves
    ACTIVE --> DEREGISTERED: officer approves
    EXPIRED --> DEREGISTERED: officer approves
    DEREGISTERED --> [*]
```

### 1.3 Certificate status

```mermaid
stateDiagram-v2
    [*] --> VALID: issued
    VALID --> SUSPENDED: officer (reauth, reason)
    SUSPENDED --> VALID: lifted
    VALID --> REVOKED: officer/admin (reauth, reason)
    SUSPENDED --> REVOKED
    VALID --> EXPIRED: validity ends
    VALID --> REPLACED: re-issued (new number)
    REVOKED --> [*]
    EXPIRED --> [*]
    REPLACED --> [*]
```

"EXPIRING" on the public page is a display state (VALID with 30 days or fewer left), not a stored status.

## 2. Registration and account approval

```mermaid
flowchart TD
    A[Open /login > Create account] --> B[1 Identity: name, DOB, mobile, email]
    B --> B1{Mobile OTP verified?}
    B1 -- no --> B
    B1 -- yes --> C[2 Role: Owner or Trader]
    C --> D[3 Business: trade licence, GSTIN, firm, type]
    D --> E[4 Address: map picker, auto Division/Zone/Circle]
    E --> F[5 Documents: licence, GST, ID proof]
    F --> G[Consent screen]
    G --> H{Age >= 18 and consent given?}
    H -- no --> G
    H -- yes --> I[Submit: account PENDING_VERIFICATION]
    I --> J[Officer of that area reviews]
    J --> K{Decision}
    K -- approve --> L[ACTIVE + SMS/email/in-app]
    K -- reject with reason --> M[REJECTED + notify with reason]
    L --> N[Owner logs in, lands on /owner/dashboard]
```

## 3. Instrument registration

```mermaid
flowchart TD
    A[/owner/instruments/new/] --> B[1 Category and capacity]
    B --> C[2 Identification: serial, make, model, year]
    C --> D[3 Location: geolocation or map]
    D --> D1{Inside owner's area?}
    D1 -- no --> D2[Flag out-of-area for officer]
    D1 -- yes --> E
    D2 --> E[4 Ownership: self or on behalf]
    E --> F[5 Attachments: invoice, photo, sticker]
    F --> G[6 Declaration + OTP]
    G --> H{Duplicate serial+make+category?}
    H -- yes --> I[Warning; officer override needed]
    I --> J{Officer overrides?}
    J -- no --> K[Stays as draft / blocked]
    J -- yes --> L
    H -- no --> L[Instrument REGISTERED + audit]
    L --> M[Success: Apply for verification CTA]
```

Draft autosaves to the server after each field; resumed from any device.

## 4. Application and document check

```mermaid
flowchart TD
    A[/owner/instruments/:id/apply/] --> B[Pre-check panel]
    B --> C{All ticks green?}
    C -- no --> D[Blocked with next step; admin contact if rule missing]
    C -- yes --> E[Choose type: New / Re-verification / Renewal / Re-test + window + OTP]
    E --> F[Server resolves rule version, due date, apply-by date]
    F --> G[Case APPLIED, pinned to rule version]
    G --> H[Officer queue + owner notified]
    H --> I[Officer document check drawer]
    I --> J{Each document}
    J -- flag --> K[Owner notified: upload again]
    K --> I
    J -- accept all --> L[Mark document check complete]
    L --> M[Case DOCUMENT_CHECKED > scheduler]
```

## 5. Scheduling

```mermaid
flowchart TD
    A[Case DOCUMENT_CHECKED] --> B[Filter inspectors: active, polygon match, capacity, holidays/leave, skill]
    B --> C{Any candidate?}
    C -- no --> D[Exception queue for officer]
    C -- yes --> E[Score: workload 35, distance 25, specialisation 15, success 10, no-repeat 15]
    E --> F[Store score breakdown; propose date inside SLA]
    F --> G{Mode}
    G -- AUTO --> H[Assign top-ranked]
    G -- REVIEW --> I[Officer reviews proposal, can override]
    I --> H
    H --> J[SCHEDULED: notify owner date/window/inspector name, notify inspector]
    J --> K{Visit day}
    K -- owner absent --> L[FAILED_ATTEMPT, slot released, reschedule]
    K -- inspector starts --> M[INSPECTION_IN_PROGRESS]
    J --> N[Owner requests reschedule: reason, min notice]
    N --> O[Officer approves > new date]
    O --> J
```

## 6. Inspection (mobile, online only)

```mermaid
flowchart TD
    A[Inspector opens visit] --> B[1 Arrive: geolocation + time + photo]
    B --> B1{Inside geofence?}
    B1 -- no --> B2[Written justification required]
    B1 -- yes --> C
    B2 --> C[Owner name unmasked]
    C --> D[2 Checklist from category template]
    D --> E[3 Test: enter load + observed reading per trial]
    E --> F[Server returns error, MPE, % error, PASS/FAIL per row]
    F --> G{All within MPE?}
    G -- no --> H[Auto recommend REJECT, reason codes mandatory]
    G -- yes --> I
    H --> I[4 Evidence: geo-tagged photos, optional audio, sticker serial, recommendation]
    I --> J[5 Review and submit]
    J --> K{Validation OK?}
    K -- no --> J
    K -- yes --> L[Submit idempotent > INSPECTED, signed test sheet PDF]
    A -. every field .-> Z[(Server draft, private, 7 days)]
```

Connection lost: blocking banner; reopening restores the server draft.

## 7. Decision and certificate

```mermaid
flowchart TD
    A[Case INSPECTED] --> B[Officer decision panel]
    B --> C{Guards: documents complete, inspection data present, MPE result, evidence}
    C -- any failed --> D[Approve blocked with explicit reasons]
    C -- all ok --> E{Decision}
    E -- reject --> F[Reason code + remarks, reauth]
    E -- refer --> G[Senior officer queue]
    E -- approve --> H[Validity from interval rule, shorter if marginal pass; reauth]
    G --> H
    H --> I{Above dual-approval threshold?}
    I -- yes --> J[Second approver, reauth]
    J --> K
    I -- no --> K[Issue in one transaction]
    K --> L[Number NRK/CERT/DIV/YYYY/seq]
    L --> M[Render PDF EN/HI + SHA-256 fingerprint]
    M --> N[QR sig = HMAC KMS key of certNo + fingerprint]
    N --> O[Update public_certificate_index + status history + audit]
    O --> P[Notify owner with secure link]
    F --> Q[Notify owner: reasons, next steps, grievance link]
```

## 8. Public validation

```mermaid
flowchart TD
    A[/validate: certificate no, QR, or mobile + serial/] --> B{Rate limit / CAPTCHA}
    B -- blocked --> C[Throttle message]
    B -- ok --> D[Normalise input]
    D --> E{QR?}
    E -- yes --> F[Recompute HMAC, constant-time compare]
    F -- mismatch --> N
    E -- no --> G[Lookup public_certificate_index via cache]
    F -- match --> G
    G --> H{Found?}
    H -- no --> N[NOT_FOUND uniform response and timing]
    H -- yes --> I{Status}
    I -- revoked --> R[REVOKED]
    I -- suspended --> S[SUSPENDED]
    I -- expired --> X[EXPIRED]
    I -- valid, <= 30 days --> W[EXPIRING]
    I -- valid --> V[VALID + Verified Seal]
    V --> Y[Log lookup: hashed IP, no PII]
    R --> Y
    S --> Y
    X --> Y
    W --> Y
    N --> Y
```

## 9. Renewal, expiry, enforcement, de-registration

```mermaid
flowchart TD
    A[Daily renewal scan] --> B[60 / 30 / 15 / 7 / 1 day reminders]
    B --> C[Instrument DUE_FOR_RENEWAL]
    C --> D{Owner renews?}
    D -- yes --> E[Renewal application > normal flow]
    D -- no --> F[Expiry sweeper: certificate + instrument EXPIRED]
    F --> G[Enforcement list]
    G --> H[Officer creates drive > bulk notice letters PDF + SMS/email]
    H --> I[Track drive: notified, applied, verified, escalated]
    J[Owner requests de-registration] --> K[Reason + document]
    K --> L{Officer approves?}
    L -- yes --> M[DEREGISTERED, public status updated]
    L -- no --> N[Rejected with reason]
```

## 10. Notification matrix

| Event | Owner | Inspector | Officer | Channels |
|---|---|---|---|---|
| Account approved / rejected (reason) | yes | - | - | SMS + email + in-app |
| Application submitted | yes | - | queue | SMS + email + in-app |
| Documents flagged / document check complete | yes | - | - | email + in-app |
| Visit scheduled / rescheduled / cancelled | yes (date, window, inspector name) | yes | yes | SMS + email + in-app |
| Visit reminder (24 h before) | yes | yes | - | SMS + in-app |
| Owner no-show (FAILED_ATTEMPT) | yes | yes | yes | SMS + in-app |
| Inspection submitted | - | - | yes | in-app |
| Approved + certificate issued | yes (download link) | yes | - | SMS + email + in-app |
| Rejected (reasons, next steps, grievance link) | yes | yes | - | SMS + email + in-app |
| Renewal reminders 60/30/15/7/1 days | yes | - | - | SMS + email + in-app |
| Certificate expired | yes | - | enforcement list | email + in-app |
| Revoked / suspended | yes | - | - | SMS + email + in-app |
| SLA breach | - | - | yes | in-app + daily digest |
| Tamper report received | - | - | yes | in-app |
| Staff invite / MFA enrolment | staff | staff | staff | email |

Rules: EN/HI templates; per-user channel preferences (security notices cannot be disabled); no sensitive data in SMS/email bodies
(application no. + secure link only); every send in `message_log` with masked recipient; dedupe and quiet hours for non-critical SMS.
