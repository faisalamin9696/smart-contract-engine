# Contributing

Thanks for improving SCE. The bar is deliberately simple: **the documented gates
pass on your machine and in CI**, and behavior changes come with tests.

## Setup

```bash
git clone https://github.com/faisalamin9696/smart-contract-engine.git
cd smart-contract-engine
npm ci
cp .env.example .env     # local defaults are fine for development
npx prisma generate
```

* `npm run dev` — watch-mode server against the memory store (no Postgres needed)
* `npm test` — full suite (unit + determinism + API integration)
* Postgres parity tests run only when `TEST_DATABASE_URL` is set (CI provides one)

## Gates (every PR must pass — CI runs them on ubuntu + Postgres 16)

```bash
npx tsc --noEmit                # strict typecheck, no emit
npx jest --runInBand            # deterministic single-worker suite
npm run build                   # tsc → dist/
npx js-yaml docker-compose.yml  # + any compose file you touched
```

Frontend work lives in the SteemNft repo with its own gates
(`npx tsc --noEmit && npm run build`).

## Ground rules

* **Determinism is contract.** The same block bytes must produce the same state
  on every machine (README → "Determinism contract"): no wall-clock, no
  randomness, no locale/float drift in contract-relevant paths.
* **Security-relevant changes** state their new trust assumption and why —
  [docs/SECURITY.md](docs/SECURITY.md) is the living document; update it in the
  same PR.
* **Migrations** are additive. Reset-style migrations are announced in release
  notes and never sneak into a PR.
* Style: strict TypeScript (already enforced), no `any` on exported surfaces,
  comments explain *why*, tests pin behavior rather than implementation.
* Large changes: open an issue first — agree on the design before code.

## Security issues

Do not open a public issue for anything exploitable — see
[docs/SECURITY.md](docs/SECURITY.md) → "Reporting".

## License

Contributions are MIT-licensed (see [LICENSE](LICENSE)).
