# G3 authenticated financial mirror protocol

Candidate only. No production configuration, keys, data or deployment changed.

OS signs exact serialized event bytes using an independent RSA key (minimum
2048 bits). Signature domain binds principal `budu-os-financial-outbox`, capability
`financial-mirror:write`, CloudBase environment, AppID, key ID, timestamp, random
nonce and body digest. CloudBase verifies before parsing and ignores any caller
supplied parsed-message substitute. Five-minute freshness and 256 KiB message cap.

Replay uses the existing durable mirror identity/version/digest semantics:
identical retries return ALREADY_APPLIED, stale versions cannot overwrite newer
facts, same-version conflicting content is rejected. No client/PIN or opposite
direction gateway key grants this capability. All keys used in tests are freshly
generated synthetic keys, never production secrets.

Evidence: companion MP mirror/auth suite 21/21 PASS; OS cross-repo test 2/2 PASS
using the real candidate signer, verifier and receiver with an offline DB adapter.
Command: `SC11B_MP_REPO=<companion checkout> node --test scripts/test-online-mirror-cross-repo.mjs`.
This is not a live CloudBase database or deployed authentication certification.

Remaining: private key mounting/public key configuration, transport preserving
bytes, trusted draft creation, HTTP/runtime wiring, singleton recovery lifecycle,
full reconciliation and deployment gates. Ordinary application startup must not
activate this unfinished route. Existing 1.1A gateway remains unchanged.
