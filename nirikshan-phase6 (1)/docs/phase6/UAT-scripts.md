# User acceptance test (UAT) scripts

Who runs these: real people from the office and a few real owners/traders, **not the developers**. Use the pilot system with **synthetic or test data only** until the office head says otherwise.

How to use: one tester per role, a printed copy or this file open beside the screen. For each step do exactly what it says, compare with "You should see", tick **Pass** or write what happened in **Notes**. A step fails if the screen is confusing even when it technically works; write that down too. Test on a phone for owner and inspector scripts, on a desktop for officer and admin.

Result key: P = pass, F = fail, B = blocked (could not reach the step).

Header to fill on every sheet: Tester name · Role · Date · Device and browser · Language used · Build/version shown in the page footer.

---
## UAT-PUB: public visitor (no login)
| # | Do this | You should see | P/F | Notes |
|---|---|---|---|---|
| PUB-1 | Open the home page | Search box, how it works, notices; page loads in under 3 seconds on mobile data | | |
| PUB-2 | Switch to Hindi, then back | Every label changes; nothing left half-English on the home page | | |
| PUB-3 | Open `/validate`, enter a valid certificate number | Green "Verified" result with a **masked** owner name, instrument, valid-till date | | |
| PUB-4 | Enter a made-up certificate number | A plain "not found" message, no technical words | | |
| PUB-5 | Scan a certificate QR with a phone camera | Same Verified page opens | | |
| PUB-6 | Open `/search`, pick a type of instrument, press Search | Results show only masked names; the button is disabled until a filter is chosen | | |
| PUB-7 | Open `/report`, describe a seal problem, send | A report number like TMP-2026-00001; status lookup says "Received" and shows nothing else | | |
| PUB-8 | Open `/rules`, `/notices`, `/help`, `/privacy`, `/terms`, `/accessibility` | Each opens, readable, with a back route home | | |
| PUB-9 | Use only the keyboard (Tab, Enter) to validate a certificate | Every control reachable, focus clearly visible | | |
| PUB-10 | Zoom the page to 200% | No text cut off, no sideways scrolling | | |

## UAT-OWN: owner (shop owner / instrument owner)
| # | Do this | You should see | P/F | Notes |
|---|---|---|---|---|
| OWN-1 | Register a new account (5 steps), give consent | "Account pending verification" page; no fee or payment anywhere | | |
| OWN-2 | After the officer approves (OFF-1), sign in with mobile + password | Owner dashboard with counts | | |
| OWN-3 | Register an instrument: category, capacity, accuracy class, serial number, address, ownership | Draft is saved between steps; a duplicate serial number is refused clearly | | |
| OWN-4 | Open the instrument, press **Apply** for verification | Pre-check passes and shows next steps | | |
| OWN-5 | Upload a required document (use a small photo or PDF) | Upload shows scanning then accepted; a wrong file type is refused with a reason | | |
| OWN-6 | Wait for / trigger the officer document check (OFF-3), read the result | Status moves forward; a plain-language timeline | | |
| OWN-7 | See the booked visit window; try **Reschedule** | New window accepted or a clear reason it is not possible | | |
| OWN-8 | After the inspection and decision (INS-*, OFF-5), open **Certificates** | New certificate with QR; Download PDF opens | | |
| OWN-9 | Press **Print** on the certificate | Clean shop-display page | | |
| OWN-10 | Request a change of address; try a second request on the same instrument | First is sent; second is refused ("already waiting") | | |
| OWN-11 | Request de-registration | Sent; instrument stays active until the officer decides | | |
| OWN-12 | Raise a grievance | Reference number and a reply-by date | | |
| OWN-13 | Settings > My data: ask for a copy of my data | "Request received" with a date | | |
| OWN-14 | Settings > Security: turn on an authenticator (optional for owners) | Works; recovery codes shown once | | |
| OWN-15 | Sign out, then press the browser Back button | You are not shown signed-in pages | | |
| OWN-16 | Do OWN-3 to OWN-9 again in **Hindi** | Everything readable and correct Hindi (note wording that sounds wrong) | | |

## UAT-TRD: trader (repair/dealer)
| # | Do this | You should see | P/F | Notes |
|---|---|---|---|---|
| TRD-1 | Bulk register instruments from the CSV template | Row-by-row problems listed; good rows imported | | |
| TRD-2 | Open **Services**, add a repair job for a customer instrument | Job in "reported" | | |
| TRD-3 | Move the job: technician assigned, repaired, sent for re-verification | Last step creates a re-verification application for the **owner**, not the trader | | |
| TRD-4 | Try to open an instrument that belongs to another business (paste its address) | "Not found", never the data | | |

## UAT-OFF: officer (verification officer)
| # | Do this | You should see | P/F | Notes |
|---|---|---|---|---|
| OFF-1 | Sign in (password, then 6-digit code). Queue > Account approvals: approve OWN-1 | Owner becomes active; owner gets a notification | | |
| OFF-2 | Queue > Duplicate overrides: review one | Reason is required to override | | |
| OFF-3 | Open the case, check each document, accept or send back with a comment | Owner sees the comment | | |
| OFF-4 | Schedule: look at the proposed visit and its score breakdown; accept | Visit assigned to an inspector in the right area | | |
| OFF-5 | Decisions: open a finished inspection, read the test results and checklist, approve | Asked to confirm identity again; certificate issued with a number and QR | | |
| OFF-6 | Decisions: reject another with a reason | Reason needed; owner sees it | | |
| OFF-7 | Certificates: suspend one, then reinstate | Public validation shows suspended, then valid again | | |
| OFF-8 | Queue > Transfers and De-registration: approve one, reject one | Reject needs a reason; instrument updates on approve | | |
| OFF-9 | Queue > Grievances: reply and close; Tamper reports: close with an action | Owner/public status changes | | |
| OFF-10 | Enforcement: open the lapsed list, start a drive for one area, print a notice letter | PDF letter opens | | |
| OFF-11 | Reports: run the registry report, download CSV and PDF | File opens; the numbers match the screen | | |
| OFF-12 | Dashboard: queue counts match the lists | Numbers agree | | |
| OFF-13 | Try to open `/admin/users` | Refused / sent away; not shown | | |

## UAT-SNR: senior officer
| # | Do this | You should see | P/F | Notes |
|---|---|---|---|---|
| SNR-1 | Run OFF-12 and OFF-11 | Wider area than an ordinary officer sees | | |
| SNR-2 | Open a decision made by an officer | Can see the case file and the history | | |
| SNR-3 | Receive a notice about an unassigned tamper report | It appears in your queue | | |

## UAT-INS: inspector (use a real phone)
| # | Do this | You should see | P/F | Notes |
|---|---|---|---|---|
| INS-1 | Sign in; open today's visits | Only your visits; large touch buttons | | |
| INS-2 | Open a visit, **Arrive** at the site (allow location) | Distance to the address shown; if far away you must explain why | | |
| INS-3 | Fill the checklist and enter test readings for each load point | Pass/fail is worked out by the system, not by you; you cannot override it | | |
| INS-4 | Attach a photo of the instrument and the seal | Photo uploaded and accepted | | |
| INS-5 | Turn the phone's network off, try to submit | The system is online-only. Expect an error message and your entries still on the screen (they are autosaved). **Write down exactly what you see**; a missing or confusing message is a finding | | |
| INS-6 | Network back on; submit with your recommendation | Visit appears as submitted; officer sees it | | |
| INS-7 | History | Your past visits listed | | |

## UAT-ADM: administrator
| # | Do this | You should see | P/F | Notes |
|---|---|---|---|---|
| ADM-1 | Users: invite a new officer | Invite link works once; they set a password and enrol an authenticator | | |
| ADM-2 | Users: suspend, then reactivate an account; Reset MFA | Each asks you to confirm identity; person is signed out | | |
| ADM-3 | Master data: view categories, areas, accuracy classes | Lists load | | |
| ADM-4 | Rules: start a draft copy, change one value, see the "what changed" list; ask a **second** admin to review; publish | You cannot approve your own draft; publish asks for identity again | | |
| ADM-5 | Audit trail: filter by a user or a record | Rows show who/what/when; no personal data in clear text | | |
| ADM-6 | System: switch the banner on in English and Hindi; switch it off | Banner visible on a public page within a minute | | |
| ADM-7 | System > Jobs: Run now on `public-stats` | Result recorded | | |
| ADM-8 | Privacy: carry out a data-copy request and an erasure request | Erasure says what must be kept by law and why | | |
| ADM-9 | Migration: upload the sample legacy CSV, check, import or discard | Problems listed by row; import is all-or-nothing | | |
| ADM-10 | Reports: run an admin-only report | Not visible to an officer | | |

## Sign-off per role
Role · Passed / total · Open failures (list with severity: blocker / must-fix-before-go-live / can-wait) · Tester signature · Date.
A role is accepted when there are **no blocker failures** and every must-fix item has an owner and a date.
