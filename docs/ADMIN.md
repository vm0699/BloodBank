# LifeLink admin portal

Open `https://<your server>/admin`. Two kinds of accounts:

| Role | Can do |
|---|---|
| **Admin** (us) | everything below |
| **Blood bank staff** | only their own blood bank: update **stock**, manage their **camps** and see who registered. They cannot see donors, requests or any personal data beyond a camp's registrants (name, group, phone). |

The first admin is created when the server first starts (`ADMIN_EMAIL` / `ADMIN_PASSWORD`, or a generated password printed once). Change it under *Change password*. Create staff in **Staff & access**.

## Pages (admin)

- **Dashboard:** registered users, ID-verified, live donors on the map, new this week, open / fulfilled requests, donations, organ pledges, pending ID reviews, DigiLocker name mismatches, open reports; donors by blood group (with how many are live); requests and sign-ups for 14 days; banks running low.
- **Donors & users:** search by name / phone / city; filter by blood group, verification, suspended, name-mismatch, live-on-map. Open a person to **edit** their details, see **DigiLocker documents** (view stored files, audit-logged), donations, requests, organ pledge; **mark verified / remove verification**, **suspend / unsuspend**, **send a message**, **erase their data**.
- **Camps:** the admin team adds and edits blood camps here (title, organiser, venue, date and time, seats, location on the map), cancels them, and sees who registered. Users see camps on the map and in *Blood drives*; hospital accounts manage their own camps from the app.
- **Hospitals:** applications from people who signed up as *Hospital or blood bank* (name, type, registration number, address, phone). **Approve** creates the public blood-bank listing and gives that account its dashboard, stock, camps and request tools in the app; **Reject** needs a reason, which the applicant sees and can fix and resubmit. Check the registration number against the licensing body before approving.
- **Verifications:** the queue of direct-ID submissions (ID number, photo, profile side by side) → Approve / Reject with a reason (shown to the user); plus DigiLocker identities whose name or date of birth differs from the profile.
- **Blood requests:** all requests with status, alerted / offers, requester; **alert more donors**, mark fulfilled / closed / reopen, delete.
- **Reports:** reports raised by users. Dismiss, **close the request**, or **suspend the user**.
- **Blood banks:** add / edit / hide banks, pick the location on a map, set components and hours, **update stock** (donors see it live in the app; below 5 units shows as low).
- **Camps:** create camps (date, time, venue, slots, host bank, map location), cancel, delete, see **registrants**. Registered users get a reminder the day before.
- **Transplant centres:** the directory shown in the Organ tab. Only add licensed transplant hospitals and eye banks.
- **Organ pledges:** every pledge with organs, next of kin, whether the family was told and whether the donor registered on NOTTO. Sensitive: do not share outside transplant coordination.
- **Broadcast:** send a notification (in-app + push) to everyone or filtered by city, blood group, verified, live donors. English and Tamil text (users on Tamil get the Tamil version if you provide it). Use *Count recipients* first.
- **Staff & access:** create admin / staff accounts, assign a staff member to a bank, reset passwords, disable accounts.
- **Settings:** days between donations (men / women), minimum / maximum age, minimum weight, alert radius and maximum donors alerted, how long a donor stays "on the map" after last activity, request expiry, per-user request limit, announcement banner shown in the app, **maintenance mode**, CSV exports (users, donations), and **Delete demo data** (removes everything created by `node seed.js`).
- **Audit log:** who did what and when (logins, edits, verifications, suspensions, exports, document views, stock changes).

## Daily routine for the team

1. Check **Verifications** and **Reports** (red badges in the sidebar).
2. Watch **Banks running low** and ask the bank to update stock or run a camp.
3. Use **Broadcast** for urgent shortages ("O-negative needed in Chennai") and campaigns.
