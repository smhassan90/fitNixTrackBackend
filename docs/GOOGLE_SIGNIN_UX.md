# Sign in with Google — User Experience (no token UI)

## What the user sees (correct)

1. Button: **Sign in with Google**
2. Google account picker (saved accounts on the phone)
3. Permission / consent screen (“FitNix wants to access your email / profile”)
4. App opens signed in

**The user never enters a password for FitNix, never sees `idToken`, never pastes anything.**

---

## What happens under the hood (invisible)

```
User taps "Sign in with Google"
        ↓
Google SDK shows account list + consent
        ↓
App receives idToken automatically (in memory)
        ↓
App POSTs { idToken } to /api/mobile/auth/google
        ↓
Backend verifies with Google, returns FitNix JWT
        ↓
App stores JWT in SecureStore → user is logged in
```

`idToken` is only between **app ↔ Google ↔ your backend**. It is not a screen or a form field.

---

## Expo / React Native (what to build)

Use `@react-native-google-signin/google-signin` (or Expo AuthSession Google).

### Setup (once)

1. Google Cloud Console → create OAuth clients:
   - **Web** client ID → put in backend `GOOGLE_WEB_CLIENT_ID` **and** app `webClientId`
   - **Android** / **iOS** client IDs for the store builds
2. Enable Google Sign-In API

### App button (concept)

```tsx
import { GoogleSignin } from '@react-native-google-signin/google-signin';

GoogleSignin.configure({
  webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID, // same as backend
  offlineAccess: false,
});

async function onPressGoogleSignIn() {
  await GoogleSignin.hasPlayServices();
  const result = await GoogleSignin.signIn(); // ← account picker + consent UI
  const idToken = result.idToken;             // ← automatic, not shown to user
  if (!idToken) throw new Error('No Google idToken');

  const res = await api.post('/auth/google', { idToken });
  // res.data.token → save to SecureStore
  // res.data.linked → true = gym member UI, false = guest (workout/analytics only)
}
```

### UI rules

- Show only **Sign in with Google** (optional: keep phone OTP as secondary later)
- Do **not** show any “enter token” field
- After success:
  - `linked: true` → full gym tabs
  - `linked: false` → workout + analytics only
  - `needsAccountSelection: true` → pick which gym member profile (same Gmail on multiple gyms)

### Backend (already done)

`POST /api/mobile/auth/google` with body `{ "idToken": "..." }` — called by the app only, never by the user.

Env on server:

```env
GOOGLE_WEB_CLIENT_ID=xxxxx.apps.googleusercontent.com
```

---

## Checklist

- [ ] Mobile: Google Sign-In button + SDK (account picker + consent)
- [ ] Mobile: silently send `idToken` to backend
- [ ] Mobile: never show token / OTP for Google path
- [ ] Backend: `GOOGLE_WEB_CLIENT_ID` set
- [ ] Portal: member email = their Gmail for personalized features
