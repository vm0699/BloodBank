# LifeLink: Project Handoff

Blood donation + organ pledge app with a live backend and an admin portal, built by **SAVRO**. Same format and stack as **Yoga Flow** and **Abacus AI** for the app (single-file web app wrapped in a Kotlin Android WebView); the backend is a Node service on **MongoDB**.

Read next: [BACKEND.md](BACKEND.md) (run, configure, deploy, backups) · [DIGILOCKER.md](DIGILOCKER.md) (verification: providers, policy) · [ADMIN.md](ADMIN.md) (portal guide) · [API.md](API.md) (endpoints).

## 1. What is built

| Area | Status |
|---|---|
| **Start choice after login:** *Become a donor* (goes straight into donor registration), *Become a user* (can become a donor later) or *Hospital / blood bank*. Under-18s are stopped on the date-of-birth screen (and refused by the server) | ✅ |
| **Map by role:** normal users see donors, needs, **camps** and transplant centres - no blood banks; donors also see blood-bank **locations**; hospital accounts see every bank **with its stock** (stock is never sent to non-hospital accounts) | ✅ |
| **Donation instructions:** before anyone offers to donate they must read the guidelines, press *Accept all instructions* and then *Submit*; the acceptance time is stored with the offer (English + Tamil) | ✅ |
| **Donor certificate:** issued the moment someone registers as a donor (name, blood group, certificate number, date, "LifeLink · SAVRO"); save as image/PDF or share | ✅ |
| **About us:** mission and the three team members with photos (from your document) | ✅ |
| **Two account types** chosen right after the OTP: **User** (looks for blood, can *become a donor* later - only donors appear on the map, get alerts and can offer help) and **Hospital / blood bank** (applies, is approved by a LifeLink admin, then manages stock, camps and the requests at its hospital, all in the app) | ✅ |
| **Hospital tools in the app:** dashboard (stock, requests at the hospital, donors online nearby, camps), one-tap stock updates that stay correct when several people edit at once, camps with seat limits and registrant lists, mark patient requests fulfilled | ✅ |
| **Profile page + Settings page** per account type (account, donor mode, language, appearance, alerts, privacy, data export, delete) | ✅ |
| **New look** inspired by the *Blood Care* Figma template: white canvas, navy text, coral accent, peach hero banner, activity grid, blood-group tiles, pill tab bar | ✅ |
| **Accounts:** phone-number + SMS OTP login, 60-day sessions, sign out, delete account, **download my data** | ✅ (Twilio Verify wired; waiting for your credentials) |
| **User database: MongoDB.** Every real user is a document (profile, blood group, health screening, verification, availability, organ pledge, donations, devices). LifeLink has its **own** database server and folder | ✅ |
| **Live donor map (Rapido-style):** approved donors who are available appear to other users **in real time** - a push stream moves their pin within about a second, markers glide, "Active now / 3 min ago", Live badge, auto-reconnect; positions are always shifted a few hundred metres | ✅ |
| **Rich profile:** name, DOB, gender, blood group, weight, height, city/area/pincode, donation preferences, night-call availability, **health screening** (a "Yes" pauses the listing), emergency contact, consent timestamp, profile-completeness meter | ✅ |
| **Request lifecycle** with real users: alert → donor offers → requester accepts (phones unlock) → donated → fulfilled | ✅ |
| **DigiLocker verification** (Setu): Aadhaar required, licence optional, DOB/gender locked from the document, one identity per account, consent expiry; mock mode for demos | ✅ sandbox verified end to end; production needs Setu go-live KYC |
| **Direct ID verification** + admin review queue | ✅ |
| **Push notifications** (Firebase) + in-app inbox | ✅ code done; needs your Firebase project |
| **Admin portal** (`/admin`): dashboard, donors (incl. screening answers), verifications, requests, reports, banks + stock, camps, centres, organ pledges, broadcast, staff roles, settings, audit log, CSV export | ✅ |
| **Languages:** English + Tamil | ✅ (have a native speaker review the Tamil) |
| **Donor cards** (blood + organ): image or PDF, share | ✅ |
| **Privacy policy + Terms** served at `/privacy` and `/terms`, linked in Settings | ✅ draft - have counsel review |
| **Hardening:** security headers + CSP on admin/legal pages, refuses to start in production with dev OTP on, DB-aware health check, rate limits, audit log, update-safe service worker | ✅ |
| **Backups:** `npm run backup` / `tools/restore.js` | ✅ |
| **Deployment:** `render.yaml` | ✅ |
| Offline demo mode (no backend) | ✅ still works |

## 2. Layout

```
index.html            the whole app (HTML + CSS + JS, no build), state in localStorage ("ll." prefix)
libs/leaflet/         vendored Leaflet (map engine)
manifest.json, sw.js, icon.svg        PWA (network-first service worker)
app/                  Android wrapper (Kotlin, AGP 8.7.3, SDK 24-35), package com.savro.lifelink
server/               backend + admin portal
  mongo/              LifeLink's own MongoDB: start-db.cmd, setup-db.js, data/ (git-ignored)
  lib/live.js         real-time hub (server-sent events)
  legal/              privacy.html, terms.html
  tools/              backup.js, restore.js, migrate-to-mongo.js, dl-check.js
render.yaml                           deployment (Render, Node runtime)
docs/                 BACKEND.md, ADMIN.md, API.md, DIGILOCKER.md, this file
LifeLink.apk          debug build
```

Edit only the root `index.html` (the Gradle build copies it into the app). Conventions as in Yoga: `ACT` click delegation (`data-act`), `layers`, feature-detected `AndroidBridge`.

## 3. Going live: what is still needed from the client

| # | What | Why | Where it goes |
|---|---|---|---|
| 1 | **A host with HTTPS** (Render blueprint included) and a **MongoDB Atlas** cluster | runs the API + admin, stores the data | `PUBLIC_BASE_URL`, `MONGO_URI` |
| 2 | **Twilio credentials** (Account SID, Auth Token, Verify Service SID; India needs DLT registration) | real OTP login | `TWILIO_*`, then `SMS_PROVIDER=twilio_verify` and remove `DEV_OTP` |
| 3 | **Setu production**: complete KYC to go live, new live keys, set the return URL to the permanent domain | real DigiLocker | `SETU_*`, `SETU_ENV=production` |
| 4 | **A Firebase project** → `google-services.json` + service-account key | push when the app is closed | `app/google-services.json`, `FCM_SERVICE_ACCOUNT_FILE` |
| 5 | **Admin email + strong password**, and a support email | first admin, privacy pages | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SUPPORT_EMAIL` |
| 6 | **Real blood banks, camps, transplant centres** (or their staff) | the app starts empty | admin portal (`node seed.js` for sample data meanwhile) |
| 7 | **A map tile provider** (MapTiler/Stadia/Mapbox) | OSM's free server is not for production traffic | tile URL in `index.html` and `server/admin/index.html` |
| 8 | **A native Tamil speaker's review** | translation quality, medical terms | `TA_DATA`/`TA_MORE` in `index.html` |
| 9 | Play Console account + app signing key | Play Store release | |

## 4. Verified

- **Backend: 36 automated tests pass** (`cd server && npm test`): OTP login and limits, profile validation, DigiLocker mock + Setu + aggregator flows against fakes, Twilio against a fake, the request lifecycle, roles, erasure, **MongoDB persistence and restart**, **real-time stream** (donor moves → other user receives it; going offline; new request and notification pushes), rich profile + health declaration, health check, security headers, privacy pages, data export, production safety check, **account types and hospital approval, and multi-user concurrency** (parallel stock edits, 25 people racing for 5 camp seats, 12 donors offering/confirming at once, double-tapped requests, 30 live streams).
- **App against the live backend (browser):** the donor map showing real registered donors, a donor's new position arriving over the stream and the marker gliding to it, the profile editor saving every new field to the server, the health answer pausing eligibility on both sides.
- **Admin portal:** all pages load; create/edit actions exercised earlier.
- **Android:** debug APK builds. **Not verified:** the APK on a physical device, real SMS, real push, production DigiLocker, the Android-only features beyond compiling.

## 5. Notes

- **Blood is never sold** and organ matching is deliberately not offered (THOTA); allocation is by licensed hospitals / NOTTO.
- **One API process per database** (the live hub and in-memory working set live in the process). That comfortably serves thousands of donors; to scale beyond one process, move the hub to Redis pub/sub and read from MongoDB directly.
- Compliance checklist: DPDP Act consent + privacy policy review + retention schedule, encrypted backups (Atlas does this), Play Store data-safety and location declarations, medical review of the eligibility questions and the health screening list (`HEALTHQ`), and rules (Admin → Settings).
- Roadmap: staff-facing fulfilment tools, more languages (one dictionary object per language), iOS wrapper.
