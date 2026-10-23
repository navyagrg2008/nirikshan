# ADR 0007: Rules lifecycle: draft, review by a different admin, publish, never edit
Permitted errors, re-verification intervals and deadlines decide real cases, so they change slowly and leave a trail.

- **States**: DRAFT, IN_REVIEW, PUBLISHED, RETIRED. A draft is a copy of the version in force; one draft at a time.
- **Immutable**: the database refuses to change rows of a published or retired version. Cases are pinned to the version in force on the day, so an old decision can always be reproduced.
- **Two people**: the author cannot review their own draft (the server checks, not just the screen). Publishing needs a fresh re-authentication.
- **Dates**: the start date must be tomorrow or later. An earlier open-ended version is closed automatically on the day the new one starts; any other overlap blocks publishing (a database exclusion rule backs this up).
- **No gaps**: a draft that drops a rule the current version has cannot be sent for review.
- **Retirement**: the nightly retention job retires versions whose end date has passed.
Why not edit in place? An edit would silently change how past cases read. Why not versioned rows in one table? Separate sets are easy to compare, easy to pin, and easy to make read-only.
Not covered: adding new rows in the editor screen; real rule values come from the department.
