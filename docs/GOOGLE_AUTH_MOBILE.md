# Google Sign-In — FitNix Mobile API

## Deploy checklist

1. **Apply migration**
   ```bash
   npx prisma migrate deploy
   ```
   Migration: `prisma/migrations/20260723120000_mobile_google_auth`

2. **Set env on Vercel (or host)**
   ```env
   GOOGLE_WEB_CLIENT_ID=xxxxx.apps.googleusercontent.com
   # optional — include if Expo uses native client IDs as token audience
   GOOGLE_ANDROID_CLIENT_ID=
   GOOGLE_IOS_CLIENT_ID=
   ```
   Redeploy after saving env vars.

3. **Match Expo `webClientId`** to `GOOGLE_WEB_CLIENT_ID` so `verifyIdToken` audience checks pass.

4. **Portal ops:** set each member’s **email** to their Gmail for personalized features. No email → guest mode only.

---

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/api/mobile/auth/google` | Public | Sign in with Google `idToken` |
| POST | `/api/mobile/auth/google/select` | Public | Pick member when multiple gyms match |
| GET | `/api/mobile/me` | Bearer | Session (`linked`, `accountType`, …) |
| POST | `/api/mobile/auth/logout` | Bearer | Invalidate session (guest `tokenVersion` too) |

Phone OTP (`/auth/request-otp`, `/auth/verify-otp`) remains for trainers/members.

---

## Login outcomes

| Case | Response |
|------|----------|
| One active member with matching email | `needsAccountSelection: false`, `accountType: "MEMBER"`, `linked: true`, `gym: {...}` |
| Multiple members | `needsAccountSelection: true`, `accounts: [...]` |
| No member match | `accountType: "GUEST"`, `linked: false`, `gym: null` |

---

## Guest vs linked

| Feature | Guest | Linked member |
|---------|-------|---------------|
| Workouts + analytics | ✅ (`guest_workout_logs`) | ✅ |
| Attendance, payments, shop, orders, notifications, push, trainer | ❌ 403 | ✅ |

403 message: *This feature is available only for gym members linked by Gmail on their profile.*

---

## User UX (Expo)

User only sees **Sign in with Google** → account picker → consent.  
They never enter a token; the app sends `idToken` to the backend silently.
