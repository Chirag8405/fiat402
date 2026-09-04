# Contributing to fiat402

## Status

fiat402 was built solo as a submission for the **Razorpay AI Buildathon 2026**
(deadline September 5, 2026). There is no formal review process, no SLA on
issues or PRs, and no maintainer team — just one person who may or may not
keep actively maintaining this after the buildathon judging period ends.
If you open an issue or PR, expect an honest but possibly slow response,
not a governed open-source process.

That said, contributions, forks, and questions are welcome. This document
just sets expectations correctly rather than implying a maturity level the
project doesn't have yet.

## Repo structure

There is no root `package.json` or workspace file — each directory below
installs and runs independently.

```
fiat402/
├── apps/
│   ├── facilitator/     # Express facilitator server — /verify, /settle,
│   │                     # /supported, Razorpay webhook receiver, state machine
│   ├── merchant/        # Next.js 15 App Router — protected resource,
│   │                     # self-facilitation (in-process verify + settle)
│   └── dashboard/       # Next.js 15 — live state machine view, decision
│                         # panel, UPI QR, SSE relay
├── packages/
│   └── scheme-upi/      # UPI scheme types + state machine (the single
│                         # source of truth for Redis key shapes and the
│                         # pub/sub event schema — see its src/state-machine.ts)
├── x402-upi-client/     # UpiSchemeClient (the actual protocol extension
│                         # registered via @x402/fetch's x402Client.register)
│                         # + a demo runner (test/demo.ts)
├── docs/
│   └── scheme_upi.md    # Protocol spec for the upi scheme
└── CLAUDE.md             # Wire format, Redis key schema, pub/sub contract —
                           # read this before touching anything that crosses
                           # a module boundary; it's the authoritative source
                           # for shapes that must not drift between modules.
```

If you're not sure where a change belongs: `packages/scheme-upi` owns
state-machine logic and key/event shapes; `apps/facilitator` owns policy
(deterministic + AI advisory), Razorpay integration, and the HTTP surface;
`apps/merchant` and `apps/dashboard` are consumers of the facilitator, not
sources of protocol logic.

## Running locally

1. Copy `.env.example` to `.env` at the repo root and fill in all values
   (Razorpay keys + webhook secret, Upstash Redis, Postgres `DATABASE_URL`,
   Gemini/Groq keys for the AI advisory layer, merchant VPA/name/price,
   policy limits, and the confirm-gate secret — see the comments in
   `.env.example` for what each one does and which are optional for a local
   demo run).
2. Install dependencies separately in each of: `packages/scheme-upi`,
   `apps/facilitator`, `apps/merchant`, `apps/dashboard`, `x402-upi-client`
   (`pnpm install` in each directory — there is no single install step).
3. Run the Postgres migration:
   `psql $DATABASE_URL -f apps/facilitator/migrations/0001_create_reconciliation_records.sql`
4. Start the facilitator: `cd apps/facilitator && npx tsx src/server.ts`
5. Start the merchant: `cd apps/merchant && pnpm dev`
6. Start the dashboard (optional, for the live console): `cd apps/dashboard && pnpm dev`
7. Run the demo: `cd x402-upi-client && npx tsx test/demo.ts`

The demo script requires the facilitator and merchant to already be running,
and the merchant to be returning 402, before it will proceed. See the root
`README.md`'s "Running locally" and "Environment variables" sections for
more detail — this file intentionally doesn't duplicate all of it.

## Coding conventions

- **TypeScript strict mode** is on (`"strict": true`) in every package's
  `tsconfig.json` (`apps/facilitator`, `apps/merchant`, `apps/dashboard`,
  `packages/scheme-upi`, `x402-upi-client`). This is the actual enforced
  bar — code that doesn't type-check under strict mode won't pass CI-style
  review.
- **No linter or formatter is currently configured** for any of these
  packages (no ESLint, Prettier, or Biome config at the repo root or inside
  any package). Don't introduce one unilaterally in a PR that's meant to do
  something else — if you think the project needs one, raise it as its own
  PR/issue so it can be discussed and applied consistently, not folded into
  an unrelated change.
- Match the surrounding file's style (this codebase leans on descriptive
  doc comments over inline chatter — see `packages/scheme-upi/src/state-machine.ts`
  for the house style: comments explain *why*, not *what*).
- `CLAUDE.md` is the authoritative source for wire formats, Redis key
  shapes, and the pub/sub event schema. If a change touches any of those,
  read it first — field names and key shapes must not drift between
  modules that independently construct or parse them.

## Tests

Every package with runtime logic uses [Vitest](https://vitest.dev/), run the
same way in each:

| Package | Command | Notes |
|---|---|---|
| `apps/facilitator` | `pnpm test` (`vitest run`) | |
| `apps/merchant` | `pnpm test` (`vitest run`) | |
| `apps/dashboard` | `pnpm test` (`vitest run`) | |
| `packages/scheme-upi` | `pnpm test` (`vitest run`) | |
| `x402-upi-client` | — | No automated test suite; `pnpm demo` (`tsx test/demo.ts`) runs a manual end-to-end demo against a live facilitator + merchant instead. |

There is no unified root test command — run `pnpm test` inside each package
directory that has one. A PR touching a given package should leave that
package's own test suite passing; if it touches shared contracts (Redis key
shapes, pub/sub event shapes in `packages/scheme-upi`), run the facilitator
and dashboard suites too, since both depend on those shapes.

## Making a change

This is a small, single-maintainer project, not a foundation with a
governance model — the process is intentionally lightweight:

1. Fork the repo and create a branch off `main`.
2. Make your change, following the conventions above.
3. Make sure the relevant package's test suite passes (`pnpm test`) and that
   `tsc` is clean under the existing strict config.
4. Open a PR with a clear description of what changed and why. Link any
   relevant issue.
5. Expect discussion, not an automatic merge — especially for anything
   touching the deterministic policy engine, the AI advisory layer, or the
   Razorpay/webhook code paths (see below).

## A note on money-handling code

This project integrates with **Razorpay Live mode** and moves real money
over **UPI**. If your change touches:

- the deterministic policy engine (`apps/facilitator/src/policy/`),
- the Razorpay integration or webhook handling
  (`apps/facilitator/src/razorpay/`),
- the state machine or its Redis key/event schema (`packages/scheme-upi`),
- or anything in the confirm-gate / settlement flow,

please be extra careful. These are the paths where a bug has a direct
financial consequence, not just a broken feature. Prefer explicit,
conservative fail-closed behavior over convenience, and call out in your PR
description what you tested and how.

**Never commit real API keys, webhook secrets, or credentials.** Use
`.env.example` at the repo root as the pattern for what environment
variables exist and what they're for — it should always describe every
variable the project reads, but should never itself contain a real value.
