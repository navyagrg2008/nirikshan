# Nirikshan user manual (English)

Nirikshan is the online system for verifying weighing and measuring instruments. You register an instrument, apply, an inspector visits, an officer decides, and you get a certificate with a QR code that anyone can check. **There is no fee or payment anywhere in this system.** If anyone asks you to pay through it, do not, and report it from `/report`.

Use it on a phone or computer. It needs an internet connection. Switch between English and हिन्दी using the button at the top right.

---
## Part A. Anyone: check a certificate, report a problem
**Check a certificate.** Open the home page or `/validate`. Type the certificate number, or scan the QR code on the certificate with your phone camera. You see **Verified** (with the instrument and valid-till date; owner names are partly hidden to protect privacy), **Suspended**, **Expired** or **Not found**. If you see anything other than Verified for a certificate on display in a shop, report it.

**Find a verified instrument.** `/search`: choose a type of instrument (and area) and press Search. Results are masked.

**Report tampering.** `/report`: write what you saw (seal broken, scale looks altered), add a photo if you can, and send. You get a report number such as TMP-2026-00001. Enter it later on the same page to see "Received" or "Looked into and closed". You will not see more than that, to protect everyone involved. Reports can be sent without logging in.

---
## Part B. Owners and traders
### 1. Create an account
Press **Register**. Five short steps: who you are, contact (mobile number, e-mail), business details if you are a trader, password, consent. Read the consent text; you can say no to optional items. After you finish, the account shows **pending verification** until an officer approves it. You will get a message. Then sign in with your mobile number or e-mail and password.

If your instruments were already in the old records, the office may already have made an account for you. Register with **the same mobile number** to claim it.

### 2. Register an instrument
Instruments > **Add instrument**. Six steps: type, capacity and accuracy class, make and serial number, address, who owns it, and a declaration. Your progress is saved, so you can leave and come back. The same serial number cannot be registered twice.

### 3. Apply for verification
Open the instrument and press **Apply**. The system checks that everything needed is there. Then upload the documents asked for (photos or PDFs, up to the size shown). Each file is scanned before it is accepted. An officer reviews them; if something is wrong you will see a comment saying what to fix. Fix it and send again.

### 4. The visit
When the documents are accepted, a visit window is booked automatically. You will see it on the application page and get a reminder. If it does not suit you, press **Reschedule**. Keep the instrument ready, clean and accessible. The inspector measures it on site; you do not need to pay or give anything.

### 5. The certificate
After the officer decides you get a notice. Open **Certificates**: your certificate shows the number, the instrument, valid-from and valid-till dates and a QR code. Press **Download PDF** or **Print** for a copy to display in the shop. Reminders come 60, 30, 15, 7 and 1 days before the certificate ends. Press **Renew** to start again.

### 6. Changes to an instrument
On the instrument page: **Change of owner**, **Change of address**, **De-registration**. Only one request can be open at a time. An officer approves or rejects (with a reason). You can withdraw a request that is still waiting.

### 7. Traders: bulk register and repair jobs
**Bulk register** accepts the CSV template and lists problems row by row before anything is saved. **Services** is your repair board: reported, technician assigned, repaired, sent for re-verification. The last step opens a re-verification application for the instrument's owner.

### 8. Problems, grievances and your data
**Grievances**: tell us what went wrong. You get a reference and a date by which the officer will reply. **Settings > My data**: ask for a copy of your data, a correction, deletion, or to close your account. Some records must be kept by law; if so, we tell you which and why.

### 9. Staying safe
Never share your password or a code. Sign out on shared phones. In **Settings > Security** you can see where you are signed in, sign out everywhere, change your password and turn on an authenticator app for extra safety.

---
## Part C. Officers (English only)
You sign in with password **and** a 6-digit code from your authenticator app. Actions that cannot be undone ask you to confirm again.

- **Dashboard**: what is waiting for you, deadlines, the work by stage.
- **Queue** tabs: Account approvals, Duplicate overrides, Transfers, De-registration, Grievances, Tamper reports. Rejecting always needs a reason.
- **Cases**: the full file. Check documents one by one; accept, or send back with a comment the owner can read.
- **Schedule**: proposed visits with the score breakdown (distance, workload, skills). Accept, change the inspector or move the time.
- **Decisions**: read the inspector's results and checklist. The system has already worked out pass/fail from the rules; you approve or reject with a reason. Issuing asks you to re-authenticate.
- **Certificates**: suspend, reinstate, revoke, re-issue. Public checks change at once.
- **Inspectors**: workload and availability. **Enforcement**: lapsed instruments, drives, printed notice letters. **Reports**: 11 reports with CSV, Excel and PDF; every download is recorded.

## Part D. Inspectors (English only, phone)
Today's visits are on the dashboard. For each visit: **Arrive** (allow location; if you are far from the address you must say why), tick the checklist, enter the readings for each test, attach photos, add a note, choose a recommendation and **Submit**. The system works out pass/fail; you cannot change it. Your entries are saved as you go. You need a network connection to arrive and submit.

## Part E. Administrators (English only)
Users (invite, suspend, reset MFA, sign out everywhere), Master data, Rules (draft, review by a **different** admin, publish with re-authentication), Audit trail, Certificates, Reports, System (banner, switches, background jobs), Privacy (data requests, retention, consent records), Migration (import old records). See the runbooks for operations.

---
## Help
`/help` has questions and answers and the contact form. Accessibility: the site is built for keyboard use and screen readers (see `/accessibility`). If something does not work for you, tell us through `/help`.
