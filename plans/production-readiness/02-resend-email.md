# 02 · Resend email

PrepPilot sends five templates: login code, candidate invite, admin invite, role assigned and export ready. Templates live in `src/jobs/email/templates/templates.ts` and are rendered before the adapter runs. Only the transport changes.

## Adapter

`src/adapters/mail/resend-mail.adapter.ts` implements `MailAdapter.send()` with the `resend` SDK (the ATS backend uses `^6.18.1`). Port the behaviour of `xenveo-ats-backend/src/mail/drivers/resend.driver.ts`:

- **Retries:** return or throw so the existing `email` queue job retries on 429, 5xx and transport errors. Never retry `validation_error` or an invalid recipient: an unverified domain will still be unverified in five minutes.
- **Idempotency key:** pass the email job id as Resend's `idempotencyKey`, which Resend keeps for 24 h. A queue retry after a lost response then can't send twice. This matters for OTP codes and invites.
- **Logging:** log the provider message id only. No recipient address, subject or body, per the privacy rule. The ATS driver masks the address; PrepPilot logs ids only.

## Configuration

```
MAIL_PROVIDER=resend | ses | console
RESEND_API_KEY=
MAIL_FROM="Xenveo <noreply@emails.xenveo.com>"
MAIL_RATE_PER_SECOND=2        # Resend's default account limit; the email queue limiter uses it
```

- Boot fails when `MAIL_PROVIDER=resend` and `RESEND_API_KEY` is missing.
- Never use `onboarding@resend.dev`. It only delivers to the Resend account owner and fails silently for everyone else, as the ATS notes say.
- `WorkspaceSettings.senderName` and `replyTo` are admin-editable. The display name in `From` comes from `senderName` when set, and the address always comes from `MAIL_FROM`; Resend rejects unverified addresses.

## Dev safety

The dev and seed data contain `example.com` / `example.test` addresses and `@company.com` admins. Sending to them through a real provider bounces, and that hurts the shared Xenveo domain's reputation.

- **New env `MAIL_ALLOWLIST`:** a comma-separated list of exact addresses or `@domain` suffixes.
  - When set, the Resend adapter sends only to allowlisted recipients. It routes everyone else to the console outbox and logs `suppressed <messageId>`.
  - Set it in dev and any test deploy; leave it empty in production.
- **Seed:** `SEED_ADMIN_EMAIL` and a real tester address are the intended way to receive mail in dev.

## Tests

- **Unit tests** use a mocked SDK: success, `validation_error` (not retried), 429 (retried), a thrown network error (retried), the idempotency key passed through, allowlist suppression, and no recipient in any log line.
- **e2e** stays on `console`.
- **P3 acceptance:** one real OTP, one invite and one export email to an allowlisted tester inbox. Check the SPF/DKIM pass in the received headers.

## Ownership (Phase 1)

Task **MAIL**: `src/adapters/mail/resend-mail.adapter{,.spec}.ts`, the mail provider wiring, the email queue rate limiter (if it isn't already configurable), the `env.ts` mail keys and `.env.example` mail section, and adding `resend` to `package.json`. It runs in parallel with the Redis task. Their `env.ts` edits collide, so either sequence the `env.ts` edit or let the Coordinator apply both blocks.
