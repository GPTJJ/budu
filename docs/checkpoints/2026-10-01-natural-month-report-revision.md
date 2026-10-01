# Natural-month report revision candidate

Status: IMPLEMENTED/LOCAL TESTED; parent independent review and release gates pending.
Repository: https://github.com/GPTJJ/budu.git
Branch: codex/natural-month-report-revision
Base: ede3ee43526a39131618287d9b5447977e5c91d3.
Device/current account VERIFIED: 灰太狼大王の黑巧酥山💻 / apple (scutil/id).
Production public health VERIFIED 2026-10-01 UTC: prod, ede3ee43526a, dbOk=true.
Full live SHA/DB identity/migrations/writer/disk/rollback have NOT been revalidated in this task.

## Scope and contract

- `--prepare-natural-month --revision V2` selects an independent report identity for all three natural-month jobs. Values are exact strings V1..V999; missing means V1. Empty/null/numeric/noncanonical/path values reject before snapshot extraction. The CLI rejects revision on other commands.
- V1 preserves historical job keys, report identity and metadata shape; current source model/Markdown/HTML/email and summary were compared directly against the ede3 baseline and matched.
- V2+ add revision to canonical run identity, metadata and jobs; therefore PDF/run/manifest/delivery identities are independent even with identical authority and amounts.
- Source lookup is by the exact revision/type/test/period job key. Summary checks matching source revision, requested period, authorityDigest and productionSha. Existing summary reuse also reconciles its canonical hash against its exact source models.
- Existing source reuse checks job/model identity, canonical hash, revision, period and type. Natural-month prepare checks both current captured authorityDigest and productionSha. Same revision with changed facts fails closed; use a new explicitly chosen revision.
- Repeated prepare reuses completed jobs/artifacts without rewrites, send or claim. Existing job emailStatus remains NOT_SENT; the existing bridge creates only DELIVERY_PENDING on explicit delivery preparation. No new status lifecycle was introduced.
- Parent send guard remains unchanged and binds reportId/canonicalHash/pdfHash/period/recipients. New revisions cannot inherit old approvals. Bytes changing invalidate artifact integrity; updated hashes invalidate approval binding.
- No payroll algorithm/authority/resolver, fact, schema/migration, weekly schedule, recipients, delivery state machine, controller or UI changes.
- Old live V1 IDs 8db75759cf23afccad8f5df0 / cc95152268c943b493a70901 / 16c7708e87596e210debcb22 and old SENDING deliveries a73cc7bb959ea757675e2838 / 7616a54cbfb82fc0771a431d were not read/written by generation or delivery commands. Fixture equivalents prove all old files/hashes/index entries stay unchanged while revisions coexist.

## Verification

- Complete report suite: 55 PASS / 0 FAIL (revision 6, natural-month 8, scheduler, delivery bridge, report-v2). Real rendering, source-change/money equality, source mismatch, invalid inputs, frozen old SENDING records, no old approval reuse, idempotency, concurrent lock rejection/retry, partial summary failure recovery included.
- Payroll baseline exact selection: 31 PASS / 0 FAIL.
- Shipping baseline: customer-request-wecom-unit + mailing-qr-workflow = 28 PASS / 0 FAIL; WebKit mailing + customer-request = 30 PASS / 0 FAIL.
- Production build PASS (`npm run build -- --configLoader runner`); diff check PASS. Existing installed dependencies reused, no software installation.
- Native PDFKit verified every page, dimensions/nonempty text and all 19 employee identities of a **41-page** fixture (at least requested 40). Four contact sheets covering all pages visually inspected: no observed clipping/overlap/blank pages. This is synthetic POS/attendance input through unchanged loadAuthoritativePayrollRange and the actual report pipeline, not production facts.
- Candidate QA report ID 6a5ff3e12e60d592d3543d84; canonicalHash 8bc4b734aad2c9016596868f3e558dc6880277f9b6a236a6e4634a2d37042581; PDF SHA256 c52b03be3465b09942464f0fbf0e48f8bd8a05a6fbdcb6351ee4380990673c21.
- QA artifacts/logs are local under output/revision-qa-40-final and /tmp/revision-*.log, excluded from commit. Earlier 39/78-page trials remain local; no cleanup of historical assets.
- Initial sandbox Chromium launch and shared Vite cache writes failed; local fixture execution was permitted via standard escalation and successful reruns. An extra DB integration test was blocked by absent loopback PostgreSQL; it is outside the required 28 fixture selection and is not represented as PASS. An extra native shipping script requires ISOLATED_NATIVE_URL and was not passed. PGlite migration rehearsal passed 7 independently.
- No production generation, write, email, state transition or dispatch executed.

Exact payroll selection:
```
node --test scripts/test-daily-entry-upgrade.mjs scripts/test-daily-entry-v2-payroll-regression.mjs scripts/test-payroll-adjustment-only.mjs scripts/test-payroll-explanation-metadata.mjs scripts/test-payroll-integration.mjs scripts/test-payroll-issue-resolver.mjs scripts/test-payroll-orphan-dependency.mjs scripts/test-payroll-payable-hours.mjs scripts/test-payroll-pos-sales-authority.mjs scripts/test-payroll-readiness.mjs scripts/test-payroll-resolver.mjs scripts/test-payroll-shadow-calculator.mjs scripts/test-payroll-shadow-input.mjs scripts/test-payroll.mjs scripts/test-pos-daily.mjs scripts/test-week-custom-payroll.mjs
```

## Future generation command (NOT EXECUTED)

After release review, live baseline/authority verification and deployment acceptance:
```
node scripts/payroll-audit-scheduler.mjs --prepare-natural-month \
  --period-start 2026-09-01 --period-end 2026-09-30 --revision V2 \
  --actual-model 'GPT-5.6 Sol' --actual-reasoning Medium \
  --preparation-thread-id '<preparation-thread>' --parent-review-thread-id '<parent-thread>'
```
Inspect all three new run IDs, source references and manifests; use only returned full-time/summary deliveryJobKeys with existing bridge prepare. Parent reviews complete new PDF content and exact report/canonical/PDF/period/recipient binding before any claim/send. Do not touch either old SENDING record, old jobs, manifests or index entries.

## Release adaptation proposal — pending parent approval

Existing build-only workflow still binds old engineering SHAs. First parent reviews business commit B on this branch. Then create engineering commit E directly on B, changing ONLY `.github/workflows/release-build-only.yml` and `scripts/test-release-path-post-transfer.py`:

1. Add this exact branch only to manual dispatch guards (no automatic production trigger), EXPECTED_PRODUCTION_SHA=ede3ee43526a39131618287d9b5447977e5c91d3 and APPROVED_BUSINESS_SHA=the reviewed full B SHA.
2. Require requested release SHA exactly github.sha, E's sole parent exactly B, and E-B exact two-file allowlist; validate branch, clean tree, Linux/X64 and existing profile identity.
3. Extend workflow tests for exact new B/E identity and negative cases; prove zero production credentials, SSH or deployment/cutover calls in build-only. Keep controller gates untouched.
4. Use original workflow to build/hash/probe the candidate. Before any production dispatch require parent approval plus fresh actual disk budgets in two rounds, including pre-upload space and archive accounting, new 10% transfer probe and complete archive/artifact hashes. No cleanup authority granted.

Only implement/test are complete here. Independent parent review, engineering adaptation, build-only dispatch, disk/probe checks, deployment, production revision generation and final delivery review remain gates. The three unrelated UI requests remain deferred.

## Independent-review P2 follow-up

The reviewer found that a trailing explicit `--revision` was parsed as undefined and could silently select V1. The CLI now rejects a missing next token or a following flag immediately with PAYROLL_AUDIT_REVISION_INVALID, before the snapshot extractor runs. Empty and illegal supplied values remain rejected by canonical revision validation.

New real-entry subprocess tests cover trailing --revision, following flag, empty value, illegal path value, a duplicate ending without a value, omitted flag/default V1 and legal V2. Tests use an isolated cwd extractor with an invocation marker, no DB client/URL, isolated output, and the actual three-report/PDF generation path. Invalid invocations produce neither extractor calls nor job/artifact writes; V1/V2 legal invocations complete and have independent run/PDF identities. CLI suite: 8 PASS; combined report suite: 63 PASS / 0 FAIL. No further business, engineering workflow, controller or production changes.

The next business B must be the final P2-fixed commit approved by the same independent reviewer, superseding 76c951da for release binding. Proposed E remains a single direct child of that approved B with exactly the original workflow and its test changed, exact branch/manual-dispatch/B/E guard and expected production ede3ee43526a39131618287d9b5447977e5c91d3. This proposal has not been implemented or dispatched.
