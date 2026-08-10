# Pipeline Analysis — Designing-Safe-Deployment

## Missing validation stages

The old workflow has three jobs: `deploy`, `lint`, `test`. That's it. There's no build stage — `npm run build` is never called anywhere, and even if it were, the script itself is a no-op stub (`echo 'Build step not configured'`). There's no test coverage gate — `npm test` runs without `--coverage`, and the jest config in `package.json` has no `coverageThreshold`, so a PR could drop test coverage to zero and nothing would notice. There's no security stage at all: no `npm audit`, no secret scanning, no SAST. Given the workflow pushes real secrets (`DEPLOY_TOKEN`, `DB_PASS`, `JWT_SECRET`) straight into a job that runs on every branch push, that's a meaningful gap.

## Execution order is backwards

```
deploy (no needs, runs first)
  -> lint (needs: deploy)
       -> test (needs: lint)
```

The `deploy` job has no `needs` key, so it runs immediately — before lint, before tests. `lint` needs `deploy` and `test` needs `lint`, so the pipeline literally ships code to production first and only checks it afterward. If the tests fail at the end, the bad code is already live. Linting and testing here are just reporting the outcome, not gating anything.

## Absent safety gates

- `environment: production` is set directly on `deploy`, the very first job. There's no staging tier, no intermediate environment to catch problems before they hit real users.
- No approval gate — nothing requires a human to sign off before production changes go out.
- `npm install` is used instead of `npm ci`. `npm install` can resolve slightly different dependency versions depending on when it runs, so what got tested locally isn't guaranteed to be what gets built in CI.
- Node version mismatch: the workflow pins `node-version: '16'` in every job, but the Dockerfile builds on `node:18`. Code can behave differently between what CI validates and what actually ships in the image.
- The smoke test result is discarded: `curl -f http://production.orion.internal/health || echo "Smoke test failed, continuing anyway"`. Whatever `curl` returns, the `||` branch always exits 0, so a failed smoke test never fails the job.
- `on: push: branches: ['*']` — this triggers a production deploy from *any* branch, not just `main`. Push to a scratch branch and you deploy to prod.

## Why failures are hard to isolate

Because deploy happens before any validation, a broken commit doesn't fail visibly in CI — it fails in production, and by the time lint/test report anything, they're describing something that's already live. There's no artifact trail linking a specific build output to what got deployed — the `deploy` job runs `npm install` and deploys straight from the checkout, so there's no single build artifact carried through to test/verify stages to compare against. There's no commit SHA, timestamp, or per-stage status surfaced anywhere (no `$GITHUB_STEP_SUMMARY` usage, no structured output), so reconstructing "what changed, when, and did it pass" after the fact means digging through raw logs. There's also a live bug baked in: the deploy step echoes `Deploying version $APP_VERSION to production...` but `APP_VERSION` is never set as an env var anywhere in the job, so that line always prints blank — a small but real example of the kind of thing this pipeline would never catch.

## Rollback gaps

`scripts/healthcheck.sh` and `scripts/rollback.sh` both already exist in the repo and do what you'd want — healthcheck pings `/health` and exits non-zero on a bad response, rollback re-points the Cloud Run service to a prior image tag. Neither is called anywhere in the workflow. There's no automated verify stage after deploy, so there's nothing in the pipeline that could even notice a bad deploy, let alone trigger `rollback.sh` automatically. Rollback today is a fully manual, out-of-band action someone has to remember to run themselves.

## Structured pipeline stages

| Stage | Purpose | Gate condition |
|---|---|---|
| Source | Checkout, resolve commit SHA, record trigger metadata | Valid ref, clean checkout |
| Build | `npm ci`, run build, produce artifact | Build succeeds, lint passes |
| Test | Unit + integration tests, coverage | All tests pass, coverage ≥ 80% |
| Security | `npm audit`, secret scan, SAST | No high/critical issues |
| Deploy-Staging | Deploy to staging environment | All prior gates passed |
| Deploy-Production | Deploy to production, gated behind manual approval | Staging verified + manual approval |
| Verify | Smoke tests, health checks post-deploy | Endpoints responding, rollback ready |

Implemented as `.github/workflows/deployment-pipeline.yml`, replacing the old `deployment.yml`.

## Notes on fixes made outside strict file scope

The repo has no ESLint config file, so `npm run lint` (called by both the old and new workflow) would fail immediately with "couldn't find a configuration file" regardless of code quality. Added a minimal `.eslintrc.json` so the lint/build stage is actually exercised rather than failing for an unrelated reason. This is a small addition, not a rewrite of any existing file.

No real GCP/Cloud Run credentials exist in this repo (`gh secret list` is empty), so the deploy steps in the new pipeline are simulated (echo what would run) rather than invoking `scripts/deploy.sh` for real. They're wired to fall back to the real script automatically if a `GCP_SA_KEY` secret is ever added.

No `package-lock.json` existed in the repo at all, so `npm ci` (needed for reproducible installs in the Build stage, replacing the old `npm install`) had no lockfile to install from. Ran `npm install` once locally to generate and commit `package-lock.json` — this isn't a source change, it's the missing dependency manifest the old pipeline should have had from the start.

## Known pre-existing bug (left unfixed, out of scope)

`src/index.js` calls `app.listen(PORT, ...)` unconditionally at module load time, with no `require.main === module` guard. Both `tests/api.test.js` and `tests/users.test.js` `require()` the app directly (via supertest), so whichever test file runs second tries to bind the same port again and fails with `EADDRINUSE` — this happens whether Jest runs suites in parallel or serially (`--runInBand`), so it isn't a worker-pool artifact. Confirmed locally:

```
npm test -- --coverage
...
FAIL tests/api.test.js
  ● GET /health › should return 200 with status ok
    listen EADDRINUSE: address already in use :::3000
Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 7 passed, 8 total
```

Line coverage on the passing suite is 91.54%, above the 80% threshold — coverage itself isn't the problem, this one test consistently fails on current `main`. Per scope lock, `src/index.js` and `tests/` are not touched here. This means the new pipeline's Test stage will currently fail on this branch, which is expected and correct: it's the gate doing its job, catching a real bug the old deploy-first pipeline would have shipped straight to production without anyone noticing. Fixing it is a one-line change (`if (require.main === module) { app.listen(...) }`) but is left for a separate PR.
