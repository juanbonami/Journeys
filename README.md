# Journeys

Customer-journey automation engine. Email/SMS are *actions* inside a workflow engine, not a scheduler.

```
form -> API -> Postgres (source of truth) -> BullMQ wake-up -> worker -> provider (SMTP/SES)
```

## Layout

```
apps/api            Fastify: form submissions, journeys, contact timeline
apps/worker         BullMQ worker + sweeper timer
packages/db         Drizzle schema + migrations
packages/engine     advance(), node handlers, trigger, sweeper (provider-independent)
packages/providers  EmailProvider interface: smtp (Mailpit) and ses
packages/shared     zod schemas: event types, journey definition
scripts/seed.ts     Milestone 1 journey (trigger -> email -> wait -> email -> exit)
```

## Run Milestone 1

```bash
pnpm install
cp .env.example .env
pnpm infra:up                # postgres, redis (AOF, noeviction), mailpit
pnpm db:migrate
SEED_WAIT_SECONDS=60 pnpm seed
pnpm dev:worker              # terminal 1
pnpm dev:api                 # terminal 2

curl -X POST localhost:3000/v1/forms/signup/submissions \
  -H 'content-type: application/json' \
  -d '{"email":"john@example.com","firstName":"John"}'
```

Email #1 appears immediately in Mailpit (http://localhost:8025); #2 after the wait.
Inspect everything that happened: `GET /v1/contacts/:id/timeline`.

## Design rules (keep these when extending)

1. **Postgres decides, BullMQ nudges.** `journey_executions.wake_at` is the schedule. Jobs carry only `{executionId, stepSeq}`.
2. **`claim()` is the concurrency guard**, not the job id. Duplicate, stale, or early jobs become no-ops.
3. **Handlers return outcomes**; `advance()` applies them with the audit row in one transaction.
4. **Enqueue after commit.** The sweeper (plain timer, not a Redis scheduler) recovers anything lost.
5. **Email is at-most-once.** `messages.idempotency_key` is unique. Only errors where the provider
   *definitely* did not accept the message (`ProviderError.definitelyNotSent`) are retried; anything
   ambiguous is marked `unknown` and never auto-resent.
6. **Suppression is enforced in the engine** (`email_status`), not by journey authors.
7. **Published journey versions are immutable**; executions pin `journey_version_id`.

## Resilience checks (verified)

- Kill -9 the worker during the wait, restart after wake time: second email sends exactly once.
- `redis-cli flushall` during the wait: sweeper re-enqueues from Postgres and the journey completes.

## Switching to SES

Verify your sender (and, in sandbox, recipient) in SES, then in `.env`:
`EMAIL_PROVIDER=ses`, `AWS_REGION=...`, standard AWS credentials, `EMAIL_FROM=<verified address>`.
Next milestone: configuration set + SNS -> SQS event destination, adapter -> internal `events`.
