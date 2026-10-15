# 🩸 LifeLink (Blood & Organ Donation)

Find blood donors and recipients on a live map, verify with DigiLocker, pledge organ donation. Android app + web app, a backend with a user database and push notifications, and an admin portal for us and for blood bank staff. English and Tamil.

Built on the same stack as Yoga Flow and Abacus AI: one offline `index.html` wrapped in a Kotlin Android WebView.

---

## ✨ Features

- **Accounts:** phone number + SMS OTP. Every registered user lives in the backend database; verified, available donors appear on everyone's live map (approximate position, never the phone number).
- **Live availability map:** nearby donors with blood group / ETA, urgent requests, blood banks + camps, transplant centres; filter by "I need" group and radius; go online / offline.
- **Blood requests:** raise a request → compatible donors nearby are alerted (push + in-app) → they offer → you accept and phone numbers unlock → mark donated → fulfilled. Share as an SOS message.
- **DigiLocker verification:** tap *I can donate* → "Continue to DigiLocker?" → redirected to DigiLocker's own site to sign in and approve access → identity documents saved to the profile for verification. One identity per account. Plus direct ID verification with admin review.
- **Donor side:** compatible requests, cool-down tracking (90 / 120 days, tunable), eligibility self-check, donation history, reminders.
- **Blood banks & camps:** live stock by group (updated by bank staff), call, directions, camp registration + reminders.
- **Organ & tissue donation:** pledge flow, next of kin, NOTTO hand-off, process guides, living-donor checklist, centre directory.
- **Donor cards:** blood donor card and organ donor card, saved as image or PDF, shareable.
- **Languages:** English and தமிழ்.
- **Admin portal (`/admin`):** dashboard, donors, ID verifications, requests, reports, blood banks + stock, camps, transplant centres, organ pledges, broadcast notifications, staff roles (admin / blood bank staff), rules & settings, audit log, CSV export.

---

## 📱 Platforms

1. **Android app (`/app`):** Kotlin + WebView hosting `index.html`, JS bridge for haptics, share, DigiLocker Custom Tab, notifications, Firebase push, file save. Android 7.0+.
2. **Web / PWA (`index.html`):** one self-contained file, Leaflet vendored in `libs/`, service worker.
3. **Backend + admin (`/server`):** zero-dependency Node 18+ service. See [docs/BACKEND.md](docs/BACKEND.md).

---

## 🛠️ Build & Run

### Backend + admin
```bash
cd server
cp .env.example .env
node server.js            # admin portal at http://localhost:8787/admin
node seed.js              # optional sample data
npm test                  # end-to-end API tests
```

### Android
```bash
./gradlew assembleDebug                                   # offline demo mode
./gradlew assembleDebug -PapiBase=http://192.168.1.5:8787 # debug build against a local backend
./gradlew assembleRelease -PapiBase=https://api.example.com
```

### Web
```bash
python -m http.server 5188   # open http://localhost:5188/index.html?api=http://localhost:8787
```

Docs: **[HANDOFF](docs/HANDOFF.md)** (status + what's needed to go live) · **[BACKEND](docs/BACKEND.md)** · **[ADMIN](docs/ADMIN.md)** · **[API](docs/API.md)**
