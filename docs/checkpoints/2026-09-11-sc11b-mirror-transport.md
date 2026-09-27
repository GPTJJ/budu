# G3 OS financial mirror sender

Candidate-only transport; no configured production endpoint or deployment.
Composes the scoped RSA signer with HTTPS POST to an explicitly configured
`/online-financial-mirror` endpoint. No URL credentials, query, fragment, custom
port or redirects are allowed. Original signed bytes are sent unchanged.

Native fetch cancellation bounds network and response read to nine seconds,
inside the existing outbox ten-second deadline. Response bodies are limited to
16 KiB and JSON; only exact eventKey/version with APPLIED, ALREADY_APPLIED or
SUPERSEDED is acknowledged. Errors are sanitized; transport never retries itself.
Outbox retains durable retry authority and never rolls back PG settlement.

Evidence: `node --test scripts/test-online-mirror-transport.mjs`: 6/6 PASS with
offline fetch responses. Covers signed bytes, exact ACK, wrong ACK, redirect,
server errors, response limits, cancellation and deadline. Not live network or
production CloudBase certification. Runtime wiring and trusted draft remain open.
