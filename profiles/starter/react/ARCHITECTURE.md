# Architecture (Next.js / React)

The harness gives this document to the AI reviewer as the reference standard.

## Structure
- `app/`: routes (App Router). **Server Components** by default; only add `"use client"` to parts that need state/events.
- `components/`: shared UI; never imports from `app/`.
- `lib/`: pure utilities, client SDKs, DB connections (server files use `import "server-only"`).
- `features/<name>/`: feature code; other features only use it through `features/<name>/index.ts`.

## Data & security
- Read/write data on the server (Server Components, Server Actions, route handlers). The client never calls the DB directly, except the Supabase client with the anon key + RLS.
- `SUPABASE_SERVICE_ROLE_KEY` and every other secret are only used in server code.
- Every Server Action / route handler checks the session and permissions before reading/writing.
- Validate input with a schema (zod) at the server boundary.

## Quality
- New business logic has unit tests; important flows have e2e tests.
- Don't fetch data in `useEffect` when it can be loaded on the server.

## Out of review scope
Formatting (Prettier), lint style (ESLint).
