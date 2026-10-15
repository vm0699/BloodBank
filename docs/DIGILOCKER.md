# DigiLocker document verification

**Goal:** a person must verify with DigiLocker before they can be listed as a donor or offer to donate. From inside the app, tapping the button (*I can donate*, *Verify with DigiLocker*) asks for permission, then opens DigiLocker's own site in a browser tab; the person signs in and consents; LifeLink gets their identity documents and saves them on their profile.

## What the user sees (matches the real screens)

1. Button tap → LifeLink sheet: "Verify with DigiLocker first… Do you want to continue?" → **Yes**.
2. Browser tab opens **DigiLocker / Meri Pehchaan**: *Sign in to your account via DigiLocker* (Mobile / Username / Other ID, **mobile pre-filled from the LifeLink account**) → OTP.
3. DigiLocker consent screen: *Issued Documents* (Aadhaar, Driving Licence, PAN…), *Profile information*, *Consent validity (today + 30 days)*, *Purpose*.
4. Back into the app → "Identity verified". The documents are on the profile, the donor can now offer and appear on the map.

LifeLink never sees the DigiLocker password or OTP.

## Who can donate (policy, changeable in Admin → Settings)

- **Aadhaar is mandatory.** A DigiLocker verification without the Aadhaar card is rejected (a driving licence alone is never enough).
- **Driving licence is optional.** It is shown as "Optional" and can be added later from the profile. Admin → Settings can make it required.
- **When it happens:** straight after the OTP login, as a required onboarding step (before "About you"). Name, date of birth and gender are then filled in from the verified document and locked. If the web page was reloaded by the DigiLocker redirect, the app resumes onboarding where it stopped.
- **Escape hatch (admin switch, default on):** "I only need to request blood" lets a patient's family request blood without verifying. They still cannot donate or be listed until verified. Turn it off in Settings to make verification absolutely mandatory.
- Server-enforced: unverified or under-policy people are not listed on the map, are not alerted, and cannot offer (`403 verify_required`).
- **Age and gender come from the verified document** and cannot be edited afterwards, so the age rule (18–65) cannot be dodged.
- A DigiLocker identity can verify **one** account only. If the verified name/date of birth differ from the profile, the person is offered to update it and admins see a **mismatch** flag.
- The consent expires (30 days in the screens above): the admin portal shows "consent until"; the person can *Sync again* any time.

What documents **can not** prove: blood group (not on Aadhaar/PAN/licence) and medical fitness. Blood group stays self-declared and the medical officer confirms fitness at every donation.

## Providers (set `DL_PROVIDER`, or leave empty to auto-detect)

| Provider | When | You need |
|---|---|---|
| `mock` (default) | development and demos. Mirrors the sign-in → OTP → consent screens. | nothing |
| `setu` | **recommended starting point.** Setu's DigiLocker API is publicly documented (consent link → status → Aadhaar JSON; scopes `ADHAR`, `DRVLC`, `PANCR`), with a sandbox. Built and tested here. | Setu account: client ID, client secret, product instance ID |
| `aggregator` | **fastest for a private company.** A licensed provider that already has DigiLocker access (Gridlines, Setu, Cashfree, Digio, Signzy, Decentro…) gives you a consent-link API. The screens in your screenshots were produced this way: the consent page says "share with *Gridlines*". | an account + API key with that provider |
| `oauth` | direct DigiLocker "requester" partnership. The consent page names *LifeLink*. | DigiLocker partner approval (client ID/secret). Entity must be registered in India. Approval is by committee; the SOP gives no timeline (see below). |

### `aggregator` setup (what is already built)

`lib/digilocker.js` calls: **init** (`POST /digilocker/init` with `redirect_uri`, `mobile_number`, `check_account_linked`, `sign_up_preference`, `consent`, `purpose`; headers `X-API-Key`, `X-Auth-Type: API-Key`, `X-Reference-ID`) → opens the returned consent URL → the provider returns the person to `https://<your domain>/api/digilocker/return/<state>` → we call **issued files** and **profile** with `X-Transaction-ID`, keep only identity/donor documents (Aadhaar, licence, PAN, voter ID, passport, blood-donor certificate), never keep an Aadhaar copy, and save everything on the profile. This is covered by `test/aggregator.test.js` against a fake provider.

The init call and headers follow Gridlines' published documentation. The **issued-files / profile paths and the response field names are best-effort defaults** because the provider's full API reference was not reachable while building. Confirm them in minutes with the sandbox key:

```bash
cd server
# .env:  AGG_API_KEY=<sandbox key>   PUBLIC_BASE_URL=https://<domain>
node tools/dl-check.js init 9876543210          # prints the provider's raw init response (consent URL + transaction id)
# open the URL, sign in, consent, then:
node tools/dl-check.js result <transaction_id>  # prints raw issued-documents + profile responses
```

If a path or field differs, set `AGG_ISSUED_PATH`, `AGG_PROFILE_PATH`, `AGG_FILE_PATH`, `AGG_ITEMS_PATH`, `AGG_URL_PATH`, `AGG_TX_PATH` (all in `.env.example`) — usually no code change. For another provider than Gridlines, set `AGG_BASE` and the paths the same way, or send the provider's API reference and the adapter is a small edit.

## What I need from you

1. **Which route?** Aggregator (recommended) or direct DigiLocker partner. The screenshots suggest you already have, or have tried, **Gridlines**: if so, tell me and continue with it.
2. **Aggregator route:** the **sandbox API key** (put it in `server/.env`, don't paste it in chat), the provider's **API reference / Postman collection** (or just paste the output of the two `dl-check` commands above, which contain no secrets), and a statement of how **the consent screen names you** (it shows the provider's registered app name unless they brand it "LifeLink"). Your business KYC for production (company registration, GST/Udyam, PAN) and their pricing plan.
3. **Direct route instead:** your entity's registration proof and DigiLocker partner approval → `DL_CLIENT_ID`, `DL_CLIENT_SECRET`, and the redirect URI `https://<domain>/api/digilocker/callback` registered; the API spec they send (to confirm endpoint paths).
4. **A public HTTPS domain** for the backend (providers only redirect back to https URLs): `PUBLIC_BASE_URL`, with `https://<domain>/api/digilocker/return/*` allow-listed if the provider asks for redirect URLs.
5. **Policy decisions:** which documents you require (Aadhaar only? Aadhaar + licence?), whether the **Blood Donor Certificate** should be requested, how long consent should last, and the **purpose text** shown on the consent screen (`DL_PURPOSE`, default "Blood donor identity verification").
6. **Legal copy:** a privacy policy URL and consent wording (DPDP Act). Aadhaar rules: we store only the last 4 digits, never the Aadhaar number or copy.

## Official prerequisites for the direct route (checked 12 Oct 2026)

Sources: NeGD *Partner Organisation Onboarding SOP* (5 June 2024), NeGD partner FAQ (updated 24 Mar 2025), *Requester API Specification v1.12*, apisetu.gov.in/digilocker. The Terms of Use PDF and the Meri Pehchaan spec v2.4 could not be opened, and **no fee schedule or approval timeline is published** in the documents that could be read.

**Eligibility (SOP section 3)**
- Registered in India under MCA / MSME / Startup India / Companies Act / Partnership / Societies / Trusts (private organisations, proprietorships and partnerships are listed as eligible).
- Demonstrable experience providing online services to Indian citizens, and a **functional website** describing those services.
- Able to access digital documents and offer a value-added service; own digital infrastructure in India (foreign firms: an Indian mobile number and a server in India).
- Own **digital signature (DSC)** and an **official domain email** (personal email domains are rejected).

**Process (SOP sections 4-6)**
1. An authorised person registers at **partners.apisetu.gov.in** using *their own* DigiLocker account.
2. Entity verification: Aadhaar OTP of the nodal officer; CIN / GSTIN / PAN / Udyam are checked.
3. Submit the **use case(s)** and the user journey (no deviation allowed later).
4. Telephonic verification call from the DigiLocker team; sign the **Terms of Use**.
5. Two-step approval: business-development review, then the Onboarding Committee (meets weekly), final approval by the CEO.
6. After approval: client ID and secret in the Partner Portal; register the exact **redirect URI** (changes by email to partners@digitalindia.gov.in). Document types / scopes are enabled per client ID (`insufficient_scope` = ask them to enable it).
7. Share the demo flow and test data before go-live. **No temporary or test access is granted** and there is no separate test environment (FAQ 47).
8. After go-live: periodic usage reports (number and type of documents accessed) and an **STQC audit report** of the application; usage is monitored. Unverified accounts are deleted after 3 months, inactive ones disabled after 3 months, leaked secrets or Terms violations lead to immediate blocking.

**Rules that affect the app**
- Aadhaar: only the e-Aadhaar **XML** can be fetched (not the PDF, because of DPDP); only the last 4 digits can be verified.
- PKCE is mandatory (`S256`); a fresh code verifier for every request; redirect URI must match exactly.
- Optional authorize parameters we now send: `purpose=verification`, `consent_valid_till`, `verified_mobile` (the OTP-verified number) and, if set, `req_doctype`.
- Files carry an HMAC (SHA-256 with the client secret) that should be checked before trusting a downloaded document.

## Recommended path

1. **Start with Setu** (documented API + sandbox; Aadhaar and driving-licence scopes). Keep **Gridlines** as the alternative (what your screenshots used) and compare written quotes from both.
2. Put the sandbox credentials in `server/.env` (`DL_PROVIDER=setu`, `SETU_*`), run `node tools/dl-check.js setu-init`, open the link, consent, then `node tools/dl-check.js setu-result <id>`. The adapter reads the fields tolerantly; if a field name differs it is a one-line change.
3. Production: ask the provider to activate the DigiLocker product, set `SETU_ENV=production`, and make sure `PUBLIC_BASE_URL` is your https domain.
