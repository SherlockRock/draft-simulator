# DRA-18: Auth Flow Investigation

**Issue**: Stagnant auth credentials are not handled well
**Status**: Investigation complete
**Linear**: [DRA-18](https://linear.app/draft-simulator/issue/DRA-18/investigate-auth-flow)

---

## Current Auth Architecture

### Flow Overview

```
User clicks Login
  -> Google OAuth 2.0 consent screen
  -> Google redirects to /oauth2callback with auth code
  -> Frontend (AuthCallback.tsx) sends code to backend
  -> Backend (routes/auth.js) exchanges code for Google tokens
  -> Backend verifies Google ID token, creates/updates User in DB
  -> Backend creates two JWTs:
       - Access Token (1 day expiry) - httpOnly cookie, path: /api
       - Refresh Token (30 day expiry) - httpOnly cookie, path: /api/auth
  -> Refresh token encrypted and stored in UserToken table
  -> Frontend (userProvider.tsx) stores user state via TanStack Query
  -> Socket.io connection established with credentials
```

### Key Files

| File | Role |
|------|------|
| `backend/routes/auth.js` | OAuth callback, token creation, refresh, revoke |
| `backend/middleware/auth.js` | Token validation (`protect`, `authenticate`, `optionalAuth`) |
| `backend/index.js` | Socket.io auth middleware (manual cookie parsing) |
| `frontend/src/userProvider.tsx` | Auth state management, socket lifecycle |
| `frontend/src/AuthCallback.tsx` | OAuth callback handler |
| `frontend/src/utils/actions.ts` | API calls with `credentials: "include"`, login/logout helpers |

---

## Findings: Stale Credential Issues

### 1. No Automatic Token Refresh During Active Sessions

**Severity: High**

The access token expires after **1 day**. The only place it gets refreshed is on initial page load via the TanStack Query `fetchUserDetails()` call, which hits `GET /api/auth/refresh-token`.

There is **no mechanism** to refresh the token mid-session. If a user keeps the app open for 24+ hours without refreshing:
- All API calls will fail with 401
- The socket connection will fail to re-authenticate on reconnect
- The user will see unexplained failures with no redirect to login

The TanStack Query `staleTime` is set to 24 hours, which matches the access token lifetime — so even TanStack won't trigger a refetch until the token is already expired.

### 2. No 401 Response Handling

**Severity: High**

API calls in `actions.ts` all check `if (!res.ok)` but never check for `401` specifically. There is:
- No automatic token refresh retry on 401
- No redirect to login on authentication failure
- No global error interceptor

The only place in the entire frontend that checks for 401 is `CanvasDetailView.tsx` (line 27), which navigates home on a 401 from the canvas detail endpoint.

### 3. Silent Auth Middleware Failures

**Severity: Medium**

`backend/middleware/auth.js` catches all errors silently and returns `null` instead of the user. This means:
- Expired tokens don't produce error responses — requests proceed as if unauthenticated
- The `optionalAuth` middleware makes this even more opaque — a user who thinks they're logged in may be treated as anonymous
- Debug logs in the middleware print full cookie values including tokens to stdout

### 4. Socket.io Auth is Best-Effort

**Severity: Medium**

In `backend/index.js`, the socket auth middleware:
- Manually parses cookies from the handshake header (instead of using `cookie-parser`)
- If JWT verification fails, it logs the error but calls `next()` without error — the socket connects as anonymous
- Some socket handlers use `socket.user?.id || socket.id` as fallback, allowing anonymous participation
- No mechanism exists to re-authenticate a socket when the access token refreshes

### 5. Fire-and-Forget Logout

**Severity: Low**

`handleRevoke()` in `actions.ts` calls the revoke endpoint without `await` and with no error handling. The frontend clears user state regardless of whether the server-side token revocation succeeded. This means refresh tokens could remain valid server-side after a "logout."

### 6. Refresh Token Database Hygiene

**Severity: Low**

The refresh token validation in `routes/auth.js` (lines 150-160):
- Iterates ALL stored tokens for a user to find a match (no early exit)
- Tokens are never cleaned up from the `UserToken` table when they expire
- Old refresh tokens accumulate in the database indefinitely

---

## Root Cause Analysis

The core problem is that the auth system was designed for a **single-page-load lifecycle**: authenticate on load, use the token for the session, done. It doesn't account for:

1. **Long-lived sessions** where tokens expire while the app is open
2. **Error recovery** when tokens become invalid mid-session
3. **Graceful degradation** that tells users what happened

---

## Recommended Solutions

### Priority 1: Add a 401 Interceptor (addresses issues 1, 2)

Create a centralized fetch wrapper that:
1. Intercepts 401 responses
2. Attempts to refresh the access token via `/api/auth/refresh-token`
3. Retries the original request with the new token
4. If refresh fails (403), redirects to login

This is the single highest-impact change. It would solve the stale token problem for all API calls without touching individual endpoints.

**Implementation approach**: Wrap or replace the raw `fetch` calls in `actions.ts` with an `authFetch` function that handles retry logic. TanStack Query's `queryFn` calls would use this wrapper.

### Priority 2: Proactive Token Refresh Timer (addresses issue 1)

Instead of only refreshing on page load, set a timer to refresh the access token ~15 minutes before expiry. This prevents the 401 from ever happening in most cases.

**Implementation approach**: In `userProvider.tsx`, after a successful token refresh, set a `setTimeout` for `(tokenLifetime - 15min)` to trigger the next refresh. Clear the timeout on logout or unmount.

### Priority 3: Socket Re-authentication (addresses issue 4)

After a token refresh, disconnect and reconnect the socket so it picks up the new cookie. The reconnection logic already exists in `userProvider.tsx` — it just needs to be triggered after token refresh.

### Priority 4: Clean Up Logging (addresses issue 3)

Remove or mask the debug `console.log` calls in `backend/middleware/auth.js` that print full cookie headers. Replace with sanitized logging that doesn't expose tokens.

### Priority 5: Await Logout (addresses issue 5)

Make `handleRevoke()` properly `await` the fetch call and handle errors. The user should only be logged out client-side after server confirmation, or at minimum see an error if revocation failed.

### Priority 6: Refresh Token Cleanup (addresses issue 6)

Add a mechanism to prune expired refresh tokens from the `UserToken` table — either via a periodic cleanup job or by deleting old tokens during the refresh flow.

---

## Out of Scope (but noted)

- **Rate limiting on auth endpoints**: No rate limiting exists on `/google/callback` or `/refresh-token`. Should be addressed separately.
- **Versus draft access control**: Anonymous users can join and act as captains via share links. This is a broader permissions question beyond auth.
- **CSRF protection**: Cookies are `sameSite: "none"` for cross-origin support, but there's no CSRF token mechanism.
