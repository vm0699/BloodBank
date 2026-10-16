# LifeLink API reference

Base: `https://<server>` · JSON in/out · `Authorization: Bearer <jwt>` unless marked public. Errors are `{ "error": "message" }` with an HTTP status (400 validation, 401 sign in again, 403 not allowed, 404, 409 duplicate, 429 rate limit). All of this is implemented in `server/` and covered by `server/test/api.test.js`.

## Public
| | |
|---|---|
| `GET /api/health` | `{ok, sms, push, digilocker: "mock"|"live"}` |
| `GET /api/config` | eligibility rules the app uses (`gapMen, gapWomen, minAge, maxAge, minWeight`), announcement, maintenance flag |
| `POST /api/auth/otp/request {phone, lang?}` | sends a 6-digit SMS code. Returns `devOtp` only when the server runs with `DEV_OTP=1` |
| `POST /api/auth/otp/verify {phone, otp, lang?}` | `{token, user, isNew}`; creates the account on first login |

## Everything the app screens need
`GET /api/sync?lat&lng&radius` → `{me, donors, feed, mine, offers, camps, banks, centres, donations, unread, config, serverTime}`
- `donors`: available + ID-verified + eligible + recently active donors near you, **position jittered ~300 m, no phone**
- `feed`: open requests near you (requester contact hidden until your offer is accepted)
- `mine`: requests you raised with every donor response (`pinged | offered | accepted | declined | confirmed`); a donor's phone appears only once you accept
- `offers`: requests you offered to help with (`offered | accepted | declined | donated`)
- `me`: profile, verification, saved DigiLocker documents (metadata), organ pledge, eligibility

## Profile & account
| | |
|---|---|
| `PUT /api/me` | any of `name, email, dob, gender, bg, weight, height, city, area, pincode, address, last, donatedBefore, conditions[], emName, emPhone, prefs[], night, health{fever,medication,tattoo,surgery,pregnant,travel,vaccine}, consent, lang`. A `true` in `health` makes the person not eligible until answered `false`. |
| `PUT /api/me/role {role}` | `user` or `hospital`. An approved hospital cannot be switched back. |
| `POST /api/requests/:id/offer {accepted:true}` | offering to donate requires `accepted: true` (the donation instructions); otherwise `400 instructions_required` |
| `GET /api/sync` → `banks[].stock` | `null` for everyone except hospital accounts |
| `me.cert` | `{no, at}` donor registration certificate number, present once the person is a donor |
| `POST /api/me/donor {enable}` | become (or stop being) a donor. Needs a blood group. Only donors are listed, alerted or allowed to offer. |
| `POST /api/hospital/apply {name,type,regNo,phone,address,city,hours,lat,lng}` | hospital application (status `pending` until a LifeLink admin approves) |
| `PUT /api/hospital {...}` | edit hospital details (updates the public blood-bank listing once approved) |
| `GET /api/hospital/me`, `GET /api/hospital/donors?radius&bg&q&verified&available`, `POST /api/hospital/invite {userIds,message}`, `POST /api/hospital/camps/:id/invite {radiusKm}`, `POST /api/hospital/camps/:id/checkin {userId}`, `GET /api/hospital/banks`, `GET /api/hospital/donations` | web hospital dashboard (approved hospitals only) |
| `GET /api/hospital/dashboard` | approved hospitals: bank + stock + revision, requests at the hospital, nearby open requests, donors online by group, camps |
| `PATCH /api/hospital/stock {group, delta}` or `{group, set, rev}` | atomic stock change; an absolute `set` must carry the `rev` it was based on, otherwise `409` with the current stock |
| `POST /api/hospital/camps`, `PATCH /api/hospital/camps/:id`, `GET /api/hospital/camps/:id/registrations` | camps owned by the hospital |
| `PATCH /api/hospital/requests/:id {status}` | mark a request at this hospital `fulfilled` / `closed` |
| `GET /api/me/export` | everything held about the signed-in person (right of access) |
| `GET /api/live` | **real-time stream** (server-sent events, `Authorization` header). Events: `donor` (a listed donor's public view with `seen`), `gone {id}`, `feed` (new request nearby), `notice` (new notification), `hello`. Pass `?lat&lng` so the server knows where you are. |
| `PUT /api/me/presence {available, lat, lng}` | go on/off the map + heartbeat. Returns `{listed, eligible, verified}` |
| `POST /api/me/devices {token, platform}` | register an FCM push token |
| `POST /api/me/donations {date, place, type}` | add a past donation |
| `PUT /api/me/organ {pledged, organs[], tissues[], kin{}, witness{}, informed, notto, living{}}` | organ & tissue pledge (server assigns the pledge ID) |
| `DELETE /api/me` | erase the account and all data |

## Blood requests
| | |
|---|---|
| `POST /api/requests {patient, bg, comp, units, urgency, hrs, hospital, city, phone, cname, note, lat, lng}` | creates the request and alerts donors → `{request, alerted}` |
| `GET /api/requests/:id` | one request |
| `PATCH /api/requests/:id {status: "fulfilled"|"closed"}` | owner only |
| `POST /api/requests/:id/alert-wider` | alert donors further away |
| `POST /api/requests/:id/offer` · `DELETE …/offer` | donor offers / withdraws (needs verified ID, compatible group, eligible) |
| `PATCH /api/requests/:id/responses/:rid {state: "accepted"|"declined"|"confirmed"}` | requester decides on an offer / confirms a donation |
| `POST /api/requests/:id/donated` | donor confirms they donated |
| `POST /api/requests/:id/report {reason}` · `POST /api/reports {kind, targetId, reason}` | moderation queue |

## Camps, notifications
`POST /api/camps/:id/register` · `DELETE /api/camps/:id/register` · `GET /api/notifications` · `POST /api/notifications/read {all|ids[]}`

## Verification
| | |
|---|---|
| `POST /api/digilocker/start {platform: "android"|"web", returnUrl?}` | `{session, authUrl, mock}` – open `authUrl` in a browser tab |
| `GET /api/digilocker/callback` | DigiLocker redirects here (server-side exchange); then redirects to `savrolifelink://digilocker/done?session=…` or `returnUrl?dl_session=…` |
| `GET /api/digilocker/result?session=` | one-time read: `{ok, error?, me}` (`id_in_use` if the DigiLocker identity belongs to another account) |
| `GET /api/digilocker/mock*` | built-in mock DigiLocker pages (only when no `DL_CLIENT_ID`) |
| `POST /api/verify/direct {idType, idNumber, name, photo}` | direct ID submission → pending until an admin decides |
| `GET /api/verify/status` | `{status, reason, me}` |

## Admin (`Authorization: Bearer <admin jwt>`)

- `GET /api/admin/hospitals?status=pending|approved|rejected`, `POST /api/admin/hospitals/:userId/decision {approve, reason}` - hospital applications; approving creates the blood bank and links it to the applicant.
`POST /api/admin/login {email, password}` · `GET /api/admin/me` · `POST /api/admin/password`
`GET /api/admin/stats` · `GET|PATCH /api/admin/users[/:id]` · `POST /api/admin/users/:id/(verify|unverify|suspend|unsuspend|notify)` · `DELETE /api/admin/users/:id` · `GET /api/admin/users/:id/doc/:docId`
`GET /api/admin/verifications` · `GET …/:id/photo` · `POST …/:id/decision {decision: "approve"|"reject", reason}`
`GET|PATCH|DELETE /api/admin/requests[/:id]` · `POST /api/admin/requests/:id/alert`
`GET /api/admin/reports` · `POST /api/admin/reports/:id/resolve {action: "dismiss"|"close_request"|"suspend_user"}`
`GET|POST|PUT|DELETE /api/admin/banks[/:id]` · `PUT /api/admin/banks/:id/stock {stock:{"A+":n,…}}` *(staff: own bank only)*
`GET|POST|PUT|DELETE /api/admin/camps[/:id]` · `GET /api/admin/camps/:id/regs` *(staff: own bank only)*
`GET|POST|PUT|DELETE /api/admin/centres[/:id]` · `GET /api/admin/organ`
`POST /api/admin/broadcast {title, body, titleTa, bodyTa, audience{city,bg,verified,listed}, dryRun}` · `GET /api/admin/broadcasts`
`GET|POST|PUT|DELETE /api/admin/staff[/:id]` · `GET|PUT /api/admin/config` · `GET /api/admin/audit`
`GET /api/admin/export/(users|donations)` (CSV) · `DELETE /api/admin/demo`
