# G3 payment recovery scanner

Candidate-only implementation; no production deployment or data mutation.

The internal scanner selects unresolved attempted payments, closing orders and
expired orders. It invokes the existing verified PG recovery service, never
prepay creation or a second monetary writer. New-purchase flags are not consulted.
Fresh unattempted, unexpired orders are skipped.

Each pass captures a finite upper ID boundary and uses keyset pagination. Failed
or ambiguous items advance the scan and are revisited on the next pass; ongoing
arrivals cannot indefinitely postpone earlier retries. Restart reselects durable
PG obligations. Concurrent ticks share the actual in-flight promise. Shutdown
drains the current item and prevents starting subsequent items. Provider I/O is
bounded by the existing transport's absolute deadline; observation timeout does
not start replacement work.

Telemetry contains counters only. Raw provider/database exceptions are not
emitted; synchronous and asynchronous telemetry failures cannot stop the loop.
RECONCILIATION_REQUIRED means handed to durable compensation, not refund complete.

## Evidence

- `node --test scripts/test-online-payment-recovery.mjs`: 9/9 PASS, including
  continuous arrivals, mid-pass database failure, overlap, shutdown and telemetry.
- `SC11B_NATIVE_CONFIG=<private local config> node --test scripts/test-online-prepay-native.mjs`:
  12/12 PASS, including actual Prisma selection and verified PG paid recovery
  with purchase flag OFF, plus cancellation of undispatched orders.
- Production build PASS. Independent review identified scan starvation and async
  telemetry rejection; both corrected with specific regression cases.

## Remaining integration

Not mounted in production runtime. Runtime composition/shutdown, compensation
and refund recovery, monitoring thresholds, trusted commerce transport and full
financial reconciliation remain required. No production-ready claim follows.
No new migration is needed for this scanner. Current candidate schema retained.
