# WhatsApp Cloud API — Login OTP Setup

FitNix uses WhatsApp **only for authentication OTP** (one message per `POST /api/mobile/auth/request-otp`). No marketing messages.

> OTP messages are **paid per delivery** by Meta. The API itself has no monthly fee.

## 1. Meta setup

1. Create a [Meta Business](https://business.facebook.com/) account
2. Create a WhatsApp Business app → **WhatsApp → API Setup**
3. Copy:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary / permanent access token** → `WHATSAPP_ACCESS_TOKEN`
4. Create an **Authentication** message template (category: Authentication)
   - Include a body variable for the code: `{{1}}`
   - Prefer a **Copy code** button
5. Wait until the template is **Approved**
6. Put the template name in `WHATSAPP_OTP_TEMPLATE_NAME`

## 2. Backend env

```env
WHATSAPP_ACCESS_TOKEN=EAAxxxx
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_OTP_TEMPLATE_NAME=fitnix_login_otp
WHATSAPP_OTP_TEMPLATE_LANG=en
WHATSAPP_OTP_BUTTON_TYPE=copy_code
WHATSAPP_DEFAULT_COUNTRY_CODE=92
WHATSAPP_API_VERSION=v21.0
```

| Variable | Meaning |
|----------|---------|
| `WHATSAPP_OTP_BUTTON_TYPE` | `copy_code` (default), `url`, or `none` — must match your template |
| `WHATSAPP_DEFAULT_COUNTRY_CODE` | `92` so `0300…` becomes `92300…` |

## 3. Behavior

| Config | Result |
|--------|--------|
| WhatsApp env set | Sends OTP on WhatsApp; `channel: "whatsapp"` |
| Dev, WhatsApp **not** set | No SMS; returns `devOtp` / uses `123456` |
| Production, WhatsApp **not** set | API error — delivery not configured |
| WhatsApp send fails | API error with provider reason (no fake `otpSent: true`) |

Phone normalization examples:

- `03001234567` → `923001234567`
- `+92 300 1234567` → `923001234567`

## 4. Test

```http
POST /api/mobile/auth/request-otp
{ "phone": "03001234567", "gymSlug": "your-gym" }
```

Success includes `"channel": "whatsapp"` and `"deliveredTo": "923001234567"`.

Check server logs for `[WhatsApp OTP] sent` or `[WhatsApp OTP] send rejected`.

## 5. Cost note

You pay Meta for each **authentication** template delivered (typically a fraction of a cent). One OTP ≈ one billable message per login request.
