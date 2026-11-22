# Auth

**Auth (`backend/src/auth/`).** `config.ts` reads `ZUMIBOT_MODE`:
- `vps` (the default) needs `ZUMIBOT_ORIGIN`. With no password or TOTP yet it serves the first-run setup wizard instead of starting the app (see First run). Sign-in takes a scrypt password plus TOTP or a recovery code, with per-IP rate limits and lockout. Sessions are hashed 30-day tokens in an `HttpOnly`/`Secure`/`SameSite=Lax` cookie (not `Strict`: Chrome on Android launches an installed PWA from the home screen as a cross-site navigation and withholds a `Strict` cookie, which signed the app out on every launch; every write and the WebSocket upgrade still need our own `Origin`). `guard.ts` (`createGate`) checks the session and `Origin` on every HTTP route and on the WebSocket upgrade.
- `local` needs `ZUMIBOT_LOCAL_SECRET` (at least 32 chars). The desktop shell creates it fresh on each launch, passes it to the server through env only, and sets it as the `cb_local` cookie. Nothing answers without it.

**First run (`backend/src/setupServer.ts`, `auth/setup*.ts`).** A vps server with no password or TOTP no longer exits:
`startSetupServer` serves the browser wizard on the same `127.0.0.1` port, and `cli.ts#serve` starts the real server
once the wizard finishes. Nothing else is built while it runs (no hub, no agents, no chats, no schedulers), so a
caller can reach only `/setup`, its files and `/api/setup/*`; every other page is a 302 to `/setup`, every other write
a 404, and a WebSocket upgrade is dropped. Each setting call needs a one-time code printed to stdout at start and kept
only as a sha256 in memory, rate-limited per IP by the same `createLimiter` sign-in uses, and checked against our own
`Origin`. `setupState.ts` decides what the current step allows: a stored password is never replaced and a stored TOTP
secret is never re-enrolled, so a leaked code cannot take the account over, and `finish` needs both, so it cannot
strand a server with no way in. `setupSteps.ts` holds the two saves the CLI and the wizard share, so `set-password`
and `setup-2fa` keep working and store exactly the same thing. Details, including what the wizard shows and why the
code goes to stdout, are in [Install and first-run setup](install.md).

Error messages name the env var, never its value. Secrets never go into logs, URLs or error messages.
