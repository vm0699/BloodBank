# Hospital dashboard

A web dashboard for hospitals, blood banks and camp organisers. It is **not** part of the phone app (the app is for people looking for blood and for donors).

**Link:** `https://lifelink-api-wtdf.onrender.com/hospital`   (admin portal: `.../admin`)

## Getting access
1. Open the link and sign in with the mobile number of the person who will manage the hospital (a one-time code is sent by SMS).
2. First time: fill in *Register your hospital* (name, type, registration / licence number, phone, full address, city).
3. A LifeLink admin checks the registration number in **Admin portal -> Hospitals** and approves (or rejects with a reason you can fix and resubmit). Approval creates the public blood bank listing.
4. Sign in again: the dashboard is unlocked.

## What is in it
| Page | What you can do |
|---|---|
| **Overview** | stock at a glance, low-stock warning, open requests, donors available nearby, upcoming camps |
| **Blood stock** | add/remove units (+1, +5, -1, -5) or set an exact number; safe when several people edit at once; export CSV |
| **Requests** | requests raised at your hospital (mark fulfilled / close), open requests within 25 km, **post a request** that alerts compatible donors |
| **Donors** | registered donors around you (10-250 km) with blood group, area, distance, availability, eligibility, donation count, ID-verified; filter and search; **invite** selected donors; export CSV. Phone numbers are never shown - donors are reached with an in-app invitation |
| **Camps** | create / edit / cancel camps, see registrants with phone numbers, **invite nearby donors**, and on camp day press **Mark donated**: the donation is recorded, the donor's cooldown starts and your stock goes up by one |
| **Blood bank map** | every blood bank on LifeLink with its units per group (click a marker) |
| **Donations** | donations recorded at your hospital; export CSV |
| **Hospital profile** | edit name, phone, hours, address (the map position is looked up from the address) |

## Privacy and limits
- Viewing the donor list and sending invitations are written to the audit log (admins can see them).
- A donor can be invited by the same hospital once every 6 hours; up to 30 invitation batches per hour.
- One mobile number per hospital for now. Several staff logins per hospital are not built yet.
