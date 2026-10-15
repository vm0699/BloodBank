# LifeLink backend

Node service (Node 18+, one dependency: the official `mongodb` driver). One process serves the **mobile API** (`/api/…`), the **admin API** (`/api/admin/…`) and the **admin portal** (`/admin`). User profiles and all app data are stored in **MongoDB** (see "Database").

```
server/
  server.js          http server, router, auth middleware, static admin hosting, scheduled jobs
  routes_app.js      mobile API (OTP login, sync, profile, requests, offers, camps, organ pledge, DigiLocker, verification)
  routes_admin.js    admin + blood-bank-staff API
  lib/store.js       the data-access API (list/get/insert/patch/remove...), JSON-file implementation (dev/tests)
  lib/mongostore.js  the same API on MongoDB (used whenever MONGO_URI is set)
  mongo/             LifeLink's OWN database server: start-db.cmd, setup-db.js, data/, log/
  lib/core.js        eligibility rules, donor matching, notifications (English + Tamil), request lifecycle, jobs
  lib/auth.js        JWT (HS256), scrypt passwords, phone normalisation
  lib/sms.js         OTP delivery: console | twilio | msg91
  lib/push.js        Firebase Cloud Messaging (HTTP v1)
  lib/digilocker.js  DigiLocker OAuth2 + PKCE broker (+ built-in mock DigiLocker)
  admin/index.html   the admin portal (single file)
  seed.js            optional sample banks / camps / centres / fake donors
  test/api.test.js   end-to-end API tests
```

## Run it

```bash
cd server
cp .env.example .env        # edit it (see below)
node server.js              # prints the first admin login the first time
node seed.js                # optional: sample data around Chennai (--lat --lng --city --users to change)
npm test                    # 9 end-to-end tests, uses a temp data folder
```

Open `http://localhost:8787/admin`. Point the app at it: Android `./gradlew assembleDebug -PapiBase=http://<your-pc-ip>:8787` (debug builds allow http), or on the web `…/index.html?api=http://localhost:8787` (remembered).

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | default 8787 |
| `NODE_ENV` | `production` turns on the safety checks (no `DEV_OTP`, warns without `JWT_SECRET`/https) |
| `SUPPORT_EMAIL` | shown on the privacy and terms pages |
| `BACKUP_KEEP` | backups to keep (default 14) |
| `MONGO_URI` | LifeLink's MongoDB connection string. Set = MongoDB storage; empty = JSON file in `DATA_DIR`. |
| `PUBLIC_BASE_URL` | public **https** URL of this server. DigiLocker redirects here. |
| `DATA_DIR` | where `jwt.secret`, ID photos and DigiLocker documents are stored (default `server/data`). **Back this folder up.** |
| `JWT_SECRET` | optional; otherwise generated once into `DATA_DIR/jwt.secret` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the first admin account (only used when no admin exists). Without a password one is generated and printed once. |
| `ALLOWED_ORIGINS` | comma-separated web origins allowed for CORS and the PWA DigiLocker return (the Android WebView origin is built in) |
| `TRUST_PROXY=1` | read the client IP from `X-Forwarded-For` (set when behind a proxy/CDN) |
| `DEV_OTP=1` | **development only**: returns the OTP in the API response so you can test without SMS. Never set in production. |
| `SMS_PROVIDER` | `console` (default, prints OTP in the log) · **`twilio_verify`** (recommended) · `twilio` · `msg91` |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio credentials |
| `TWILIO_VERIFY_SID` | Twilio Verify service SID (`VA…`) for `twilio_verify` |
| `TWILIO_FROM` / `TWILIO_MESSAGING_SERVICE_SID` | sender for plain `twilio` |
| `TWILIO_EXTRA_PARAMS` | JSON merged into Twilio requests (anything India/DLT needs) |
| `MSG91_AUTHKEY`, `MSG91_TEMPLATE_ID` | for MSG91 (needs a DLT-registered template) |
| `FCM_SERVICE_ACCOUNT_FILE` / `FCM_SERVICE_ACCOUNT_JSON` | Firebase service-account key for push |
| `DL_CLIENT_ID`, `DL_CLIENT_SECRET` | DigiLocker partner credentials. Empty = mock DigiLocker. |
| `DL_BASE`, `DL_AUTHORIZE_URL`, `DL_TOKEN_URL`, `DL_USER_URL`, `DL_ISSUED_URL`, `DL_FILE_URL`, `DL_EAADHAAR_URL` | override DigiLocker endpoints if the spec you receive differs from the defaults |
| `DL_FETCH_FILES=1` | also download the approved identity PDFs (never Aadhaar) so the admin can view them later |
| `APP_RETURN_URL` | Android deep link, default `savrolifelink://digilocker/done` |

## How the app talks to it

The app is **offline demo** until it has a backend URL; with one it becomes the live app:

1. **Login:** `POST /api/auth/otp/request` → SMS → `POST /api/auth/otp/verify` → JWT (60 days). New users then fill in their profile (`PUT /api/me`).
2. **Everything on screen** comes from one call, `GET /api/sync?lat&lng&radius` (me, nearby verified donors, open requests, my requests and offers, camps, banks, centres, donations, unread count, rules). The app calls it every few seconds while open, and again after every action.
3. **Presence:** a verified, eligible donor who switches on "available" sends `PUT /api/me/presence` (location + heartbeat every 30 s). Other users only ever receive a position jittered by up to 300 m (stable per hour) and never a phone number.
4. **Requests:** `POST /api/requests` → the server alerts up to 12 compatible, verified, eligible, available donors nearest the hospital (in-app inbox + push, in the donor's language). A donor taps *I can donate* → requester sees the offer → *Accept* unlocks both phone numbers → either side confirms *donated* → donation recorded, donor cooldown starts, request fulfilled when all units are received.
5. **Jobs (every 10 min):** expire stale requests, "you can donate again" notifications, camp reminders the day before.

Full endpoint list: [API.md](API.md).

## DigiLocker (what happens, step by step)

1. The donor taps **I can donate** (or Verify) while unverified → the app asks "Continue to DigiLocker?" → **Yes**.
2. App → `POST /api/digilocker/start` (signed in) → server creates a session bound to that user, a `state` and a PKCE challenge, returns DigiLocker's authorize URL.
3. The app opens it in a Chrome Custom Tab. **On DigiLocker's own website** the person signs in (we never see the password/OTP) and is asked whether LifeLink may access their documents.
4. DigiLocker redirects to `PUBLIC_BASE_URL/api/digilocker/callback`. The server exchanges the code (client secret + PKCE verifier), reads the profile, the issued-documents list and the masked Aadhaar number.
5. It saves the result on that user: `verify = verified (digilocker)` with name, DOB, gender, last 4 of Aadhaar and **documents related to identity/donation** (Aadhaar, driving licence, PAN, voter ID, passport, blood-donor certificate; everything else is ignored). With `DL_FETCH_FILES=1` the non-Aadhaar PDFs are stored under `DATA_DIR/docs/<userId>/` for later manual verification. **A full Aadhaar number or Aadhaar copy is never stored.**
6. One DigiLocker identity can only verify one account (`id_in_use`). If the name/DOB differ from the profile the user is offered to update, and admins see a **mismatch** flag.
7. The server redirects back into the app (`savrolifelink://digilocker/done?session=…`); the app reads `GET /api/digilocker/result` and refreshes.

With no `DL_CLIENT_ID` the server runs a **Mock DigiLocker** (a sign-in page with ID + PIN and a consent page with document checkboxes) so this whole flow works end to end for development and demos. To go live you need DigiLocker partner credentials and the redirect URI `PUBLIC_BASE_URL/api/digilocker/callback` registered.

## Push notifications (Firebase)

Without Firebase, alerts still arrive in the in-app inbox and as a toast while the app is open. For alerts when the app is closed:

1. Create a Firebase project, add an Android app with package `com.savro.lifelink`.
2. Download **google-services.json** into `app/` and rebuild the APK.
3. Create a service-account key (Project settings → Service accounts) and set `FCM_SERVICE_ACCOUNT_FILE`.
4. Users' devices register their token automatically after login (`POST /api/me/devices`).

## Database (MongoDB)

LifeLink has its **own** MongoDB, kept apart from any other project on the machine:

| | |
|---|---|
| Server process | its own `mongod`, started by `server\mongo\start-db.cmd` (`npm run db`) |
| Port | **27418**, 127.0.0.1 only (your other MongoDB on 27017 is never touched) |
| Data folder | `server/mongo/data/` (inside this project) |
| Database | `lifelink`, with its own login `lifelink_app` (read/write on `lifelink` only) |
| Connection string | `MONGO_URI` in `server/.env` (created by `npm run db:setup`, never printed) |

First time: `npm run db` (leave it running) -> `npm run db:setup` -> `node server.js`. Existing JSON data: `npm run db:migrate`.

How it works: `lib/mongostore.js` loads every collection into memory at start, serves reads from memory and writes only the changed documents to MongoDB a fraction of a second after each change (`users, requests, banks, camps, centres, donations, notifications, reports, verifications, admins, audit, broadcasts, otps`; settings live in `_docs`). That is right for a single server process serving thousands of donors; it is **one process per database** - do not run two API servers on one database.

Production: use MongoDB Atlas (or any managed MongoDB) and put its connection string in `MONGO_URI`. Nothing else changes. Turn on automated backups there.

## Real time

`GET /api/live` keeps one server-sent-events stream open per signed-in app (max 3 per user). `PUT /api/me/presence` pushes a `donor` event (position already jittered) to every connected user within 60 km, `gone` when a donor goes offline, `feed` when a request is raised within 40 km, and `notice` when someone gets a notification. The app also keeps its 12-20 s sync as a safety net, so a dropped stream only costs freshness, never data. Behind a proxy, disable response buffering for `/api/live` (the server sends `X-Accel-Buffering: no`; Render and Cloudflare work as is). A heartbeat comment is sent every 20 s.

## Backups

```bash
npm run backup                              # server/backups/lifelink-YYYYMMDD-HHMM.json.gz, keeps the newest 14
node tools/restore.js backups/<file> --yes  # replaces all data with the backup (MongoDB)
```
Schedule `npm run backup` daily (Task Scheduler / cron). On Atlas also enable its continuous backups. Keep backup files private: they hold personal data.

## Production checklist

- `NODE_ENV=production` (the server then refuses `DEV_OTP=1`), `PUBLIC_BASE_URL=https://...`, `TRUST_PROXY=1`, `JWT_SECRET` (long random), `MONGO_URI` (Atlas), `ADMIN_PASSWORD`, `SUPPORT_EMAIL`.
- Twilio Verify + DLT, Setu production keys and return URL, Firebase.
- Privacy policy (`/privacy`) and terms (`/terms`) reviewed by counsel; set the URL in Play Console.
- A paid map tile provider; monitor `/api/health` (returns 503 when the database is unreachable).
- Deploy with `render.yaml` (Render, plain Node: build `cd server && npm ci --omit=dev`, start `cd server && node server.js`).

## Deploying

Any host that runs Node 18+ behind HTTPS works (Render, Railway, Fly.io, a VPS with Caddy/Nginx). Needs a MongoDB (Atlas) `MONGO_URI`, and a small persistent disk for `DATA_DIR` (JWT secret, verified documents). Set `PUBLIC_BASE_URL`, `TRUST_PROXY=1`, a strong `ADMIN_PASSWORD`, SMS provider variables, never `DEV_OTP`. Then build the app with `-PapiBase=https://your-domain`.

## Security notes

- OTPs: 6 digits, SHA-256 hashed with a server secret, 5-minute expiry, 5 attempts, 3 requests / 10 min / number, 15 / hour / IP.
- Passwords (admin): scrypt. Admin sessions 12 h. Login throttled. Suspending a user revokes their token immediately.
- Staff accounts are confined to one blood bank by the server (not just the UI). Every admin action is written to the audit log; viewing an ID photo or document is logged too.
- ID photos are deleted when a direct verification is approved; the stored ID number is masked to its last 4 digits.
- Account deletion (`DELETE /api/me`, or by an admin) removes the user, notifications, donations and files and anonymises requests others still see.
- Add a privacy policy, retention schedule and encrypted backups before launch (DPDP Act 2023).

## OTP with Twilio

- **`SMS_PROVIDER=twilio_verify` (recommended):** create a *Verify service* in the Twilio console, then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SID`. Twilio generates, texts and checks the code; LifeLink never sees or stores it (tested against a fake Twilio in `test/twilio.test.js`).
- **`SMS_PROVIDER=twilio`:** LifeLink generates the code and sends it as a normal SMS (`TWILIO_FROM` or a messaging service).
- **India:** carriers deliver only SMS whose sender ID and template are registered on the DLT portal. Twilio documents this requirement and handles registration with you; plan for it before launch (days, not minutes). Trial accounts can only text numbers you have verified in the console.
- A missing setting is printed at startup instead of failing silently.
