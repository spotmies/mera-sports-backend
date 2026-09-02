# WhatsApp Templates — Replication Reference

> Everything the backend sends through the WhatsApp Cloud API, in the form you
> need to re-create it in another Meta account.
>
> **Source of truth**: `utils/whatsapp.js`. Every payload below was read out of
> that file, not from memory.
>
> Last verified: 25 August 2026

---

## 1. Current sender

| | |
|---|---|
| Phone number | **+91 87909 05361** |
| Verified name | **AV Sports Club** |
| `WHATSAPP_PHONE_ID` | `989797254211062` |
| Meta app | `Sports Paramount` (app id `4182785751988722`) |
| Graph version | `v25.0` |

Templates **cannot be copied between accounts** — each one must be created and
approved again in the new account. Nothing else about them changes.

---

## 2. The one rule that breaks sends

Meta validates the **number and order of variables** in each component against
the approved template. Get those right and the send works.

The **wording is yours** — a different sentence does not fail the send, it only
changes what the player reads. (One exception worth knowing: the admin Broadcast
page previews the wording listed below from `renderBroadcastPreview`, so if you
change the broadcast body text, that preview stops matching what is actually
delivered.)

Two more things are fixed at approval time and cannot be edited later:

- **Header type.** This is why `registration_confirmation`/`registration_receipt`
  and `event_announcement`/`event_announcement_image` exist as pairs — same
  message, one with a text header and one with a document/image header.
- **Language.** Meta treats *English* (`en`) and *English (US)* (`en_US`) as
  different translations. Sending to the wrong one fails with
  `132001 Template name does not exist in the translation`, which reads like
  "not approved yet" and will send you chasing approval status.
  **Create all seven in plain English (`en`)** in the new account, then set
  `WHATSAPP_TEMPLATE_RECEIPT_LANG=en` and this problem disappears.

Also: template **parameters cannot contain newlines, tabs or 4+ consecutive
spaces** — Meta rejects the send with error `132000`. The code collapses them
before sending, which is why a multi-paragraph broadcast arrives as one
paragraph. That is a property of templates, not a bug.

---

## 3. The seven templates

### 3.1 `otp`

| | |
|---|---|
| Category | Authentication |
| Language | `en` |
| Header | none |
| Body variables | **1** |
| Buttons | **1 URL button**, with a variable |
| Sent by | `sendOtpWhatsApp` → `services/otpService.js` |
| Triggered by | Mobile signup OTP, mobile verification OTP, forgot-password OTP |

Body `{{1}}` = the 6-digit code. The button also takes the code as its one
parameter — that is Meta's standard **Authentication** template with a
*Copy code* button, which produces exactly this payload:

```json
{ "type": "body",   "parameters": [{ "type": "text", "text": "482915" }] }
{ "type": "button", "sub_type": "url", "index": "0",
  "parameters": [{ "type": "text", "text": "482915" }] }
```

> In WhatsApp Manager, pick **Authentication** → *One-time passcode* →
> **Copy code** button. Meta supplies the body text itself
> ("*{{1}}* is your verification code…"); you do not type it.

**This is the highest-risk one to get wrong** — mobile OTP is WhatsApp-only.
There is no SMS fallback any more, so until this template is live in the new
account, nobody can sign up or reset a password by mobile.

---

### 3.2 `welcome_credentials`

| | |
|---|---|
| Category | Utility |
| Language | `en` |
| Header | none (or a static text header with no variable) |
| Body variables | **3** |
| Buttons | none |
| Sent by | `sendWelcomeWhatsApp` |
| Triggered by | Player signup (`authController.js`), institute bulk student import, `scripts/notify_player_id_change.js` |

| Variable | Content | Example |
|---|---|---|
| `{{1}}` | Player name | `Ravi Kumar` |
| `{{2}}` | Player ID | `SP10432` |
| `{{3}}` | Password (plain text, first issue only) | `xY7k2m` |

Suggested body — mirrors the welcome email:

```
Welcome to Sports Paramount, {{1}}!

Your account is ready.
Player ID: {{2}}
Password: {{3}}

Please log in and change your password.
```

---

### 3.3 `registration_confirmation`

| | |
|---|---|
| Category | Utility |
| Language | `en` |
| Header | text, **no variable** (the code sends no header component) |
| Body variables | **6** |
| Buttons | none |
| Sent by | `sendRegistrationWhatsApp` |
| Triggered by | Fallback whenever `registration_receipt` cannot be sent (PDF missing, template not live, unreachable link) |

| Variable | Content | Example |
|---|---|---|
| `{{1}}` | Player name | `Ravi Kumar` |
| `{{2}}` | Event name | `Summer Open 2026` |
| `{{3}}` | Registration number | `REG-1785134797962` |
| `{{4}}` | Categories, comma-joined | `U-17 (Mixed) - Doubles` |
| `{{5}}` | Amount, digits only — the ₹ is literal text in the template | `1800` |
| `{{6}}` | Status | `Verified` |

Same six variables in the same order as `registration_receipt` below — keep the
two bodies identical apart from the "receipt is attached" line.

---

### 3.4 `registration_receipt`

| | |
|---|---|
| Category | Utility |
| Language | **`en_US` today** — create as `en` in the new account and set `WHATSAPP_TEMPLATE_RECEIPT_LANG=en` |
| Header | **DOCUMENT** (dynamic — the receipt PDF) |
| Body variables | **6** (identical to `registration_confirmation`) |
| Buttons | none |
| Sent by | `sendRegistrationReceiptWhatsApp` |
| Triggered by | Successful payment (`paymentController.js`), `scripts/resend_registration_confirmations.js` |

Body, **verbatim as approved today**:

```
Hello {{1}}, your registration for {{2}} is confirmed.

Registration No: {{3}}
Categories: {{4}}
Amount Paid: ₹{{5}}
Status: {{6}}

Your receipt is attached above. Please carry a valid photo ID (Aadhaar) to the venue for verification. Good luck!
```

The header is sent as a link Meta fetches server-side:

```json
{ "type": "header", "parameters": [{ "type": "document",
  "document": { "link": "<signed bucket url>", "filename": "Receipt.pdf" } }] }
```

> The link must be **directly fetchable with no auth and no redirect**. A signed
> bucket URL works; the `/api/files/...` route does not, because it answers with
> a 302 that Meta does not reliably follow.

---

### 3.5 `registration_status`

| | |
|---|---|
| Category | Utility |
| Language | `en` |
| Header | none |
| Body variables | **4** |
| Buttons | none |
| Sent by | `sendRegistrationStatusWhatsApp` |
| Triggered by | Admin verifying or rejecting a registration — single and bulk (`adminEventController.js`) |

| Variable | Content | Example |
|---|---|---|
| `{{1}}` | Player name | `Ravi Kumar` |
| `{{2}}` | **Registration number** | `REG-1785134797962` |
| `{{3}}` | **Event name** | `Summer Open 2026` |
| `{{4}}` | Status | `Verified` / `Rejected` |

> Note the order: name → **registration number** → **event name** → status.
> That is the reverse of variables 2 and 3 in the two registration templates
> above. Easy to transpose when retyping; a transposed template sends fine and
> just reads wrong.

Suggested body:

```
Hi {{1}}, there is an update on your registration {{2}} for {{3}}.

Status: {{4}}
```

---

### 3.6 `event_announcement`

| | |
|---|---|
| Category | Utility |
| Language | `en` |
| Header | **TEXT with `{{1}}`** = the broadcast title (≤ 60 chars) |
| Body variables | **2** |
| Footer | `Sports Paramount` |
| Buttons | none |
| Sent by | `sendBroadcastWhatsApp` |
| Triggered by | Admin panel → **Broadcast**, when no image is attached |

Body, **verbatim** (this is what the admin preview renders):

```
Hi {{1}},

{{2}}

Open the Sports Paramount app for full details.
```

| Variable | Content | Limit |
|---|---|---|
| header `{{1}}` | Broadcast title | 60 chars |
| body `{{1}}` | Recipient's name (falls back to `Player`) | — |
| body `{{2}}` | The admin's message | 1024 chars |

---

### 3.7 `event_announcement_image`

Identical to `event_announcement` in every respect — same body, same footer,
same two body variables — except the header is **IMAGE** instead of text.

| | |
|---|---|
| Header | **IMAGE** (dynamic) |
| Triggered by | Admin panel → **Broadcast**, when an image *is* attached |

There is no title variable here: with an image header the title has nowhere to
go, so only the two body variables are sent.

> Same trap as the receipt PDF — the image URL must be a direct, signed,
> redirect-free link that Meta's media downloader can fetch.

---

## 4. Quick sheet

| Template | Category | Lang | Header | Body vars | Buttons | Footer |
|---|---|---|---|---|---|---|
| `otp` | Authentication | `en` | — | 1 | 1 URL (1 var) | — |
| `welcome_credentials` | Utility | `en` | — | 3 | — | — |
| `registration_confirmation` | Utility | `en` | text, static | 6 | — | — |
| `registration_receipt` | Utility | `en_US` | **document** | 6 | — | — |
| `registration_status` | Utility | `en` | — | 4 | — | — |
| `event_announcement` | Utility | `en` | **text, 1 var** | 2 | — | `Sports Paramount` |
| `event_announcement_image` | Utility | `en` | **image** | 2 | — | `Sports Paramount` |

---

## 5. Switching the backend to the new account

Template names are read from env, defaulting to the names above — so if you
create them under the same names, only the credentials change.

| Variable | Change? | Note |
|---|---|---|
| `WHATSAPP_PHONE_ID` | **yes** | new number's phone id |
| `WHATSAPP_TOKEN` | **yes** | new permanent system-user token; needs `whatsapp_business_messaging` |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | keep | must match the new app's Configuration screen |
| `WHATSAPP_TEMPLATE_RECEIPT_LANG` | **set to `en`** | if you create the receipt as plain English, as recommended |
| `WHATSAPP_TEMPLATE_*` (names) | only if renamed | `_OTP`, `_WELCOME`, `_REGISTRATION`, `_STATUS`, `_RECEIPT`, `_BROADCAST`, `_BROADCAST_IMAGE` |

Update in **three** places: local `.env`, the **QA** Railway backend service,
and the **PROD** Railway backend service.

> `.env` currently documents only five of the seven name overrides — `_STATUS`,
> `_RECEIPT` and `_RECEIPT_LANG` are missing from the comment block even though
> the code reads them.

Then re-register the delivery webhook in the new Meta app —
`https://<backend>/api/whatsapp/webhook`, subscribed to the **`messages`**
field. Without it broadcasts still send but never show delivered/read.

The public site's "chat on WhatsApp" link is **not** affected by any of this —
it is built from the contact phone number in admin **Settings**
(`whatsappHref` in `me-ra-sports-hub/src/lib/contactLinks.ts`). Update it there
if the public-facing number changes too.

---

## 6. Verifying before you trust it

```bash
# Prints every template on a WABA with its real component structure.
# WABA ID comes from the WhatsApp Manager URL (waba_id=...).
node scripts/dump_whatsapp_templates.js <WABA_ID>

# Live send of a real receipt to one number — needs no database.
node scripts/test_whatsapp_receipt.js 9876543210
node scripts/test_whatsapp_receipt.js 9876543210 --text-only
```

Run the dump against the **old** account first if you want the approved wording
of `otp`, `welcome_credentials` and `registration_status` verbatim — those three
were created by hand in WhatsApp Manager and their exact copy was never recorded
in this repo, so the bodies suggested above are reconstructions from the
variables the code sends. The variable counts and order are exact either way.
