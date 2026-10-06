# Architecture (Rails)

The harness gives this document to the AI reviewer as the reference standard. Keep it short; write rules, not history.

## Layers and responsibilities
- **Controller**: receives the request, calls services/models, picks the response. No business logic longer than ~10 lines, no raw SQL.
- **Model**: data, validations, scopes, associations. Knows nothing about HTTP (params, session, render).
- **Service object** (`app/services`): multi-step business logic, external API calls, large transactions. One public `call` method.
- **Query object** (`app/queries`): complex, reusable queries.
- **View/Component**: display only. No DB queries.
- **Job** (`app/jobs`): idempotent; takes ids, not objects.

## Mandatory rules
- Every new endpoint has authorization (Pundit/CanCan/…) and a request spec.
- Migrations: don't call app models; provide `down` or use a reversible `change`; index every foreign key.
- No unconditional `update_all`/`delete_all`. No N+1 in rendering loops (use `includes`).
- Secrets are only read from `Rails.application.credentials` or ENV, never hardcoded.

## Out of review scope
Style and formatting (RuboCop handles them), variable naming.
