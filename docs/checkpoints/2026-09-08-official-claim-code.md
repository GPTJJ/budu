# Official Sweet Card MiniProgram Code Candidate

Status: CANDIDATE_VERIFIED / LIVE_SCAN_PENDING. Not SWEET_CARD_CLAIM_MINIPROGRAM_CODE_READY.
Base Production: 7b571a53de02105d164503518f29b33ad68af5fd.
Branch: codex/sweet-card-official-code. Local candidate; not pushed.

Root cause: ordinary QR encoded an internal MiniProgram page path. It did not open WeChat.
Replacement uses official stable_token + getwxacodeunlimit, fixed actual page
pages/sweet-card-claim/sweet-card-claim, check_path=true, release in Production.
Scene is the existing random Claim record UUID without separators (32 characters,
122 random bits). No raw Claim/POS secret, user identity or signature in scene.
Existing separate proof remains mandatory. Shared lookup resolves scene to the
same Claim record for preview/resolve/claim; old long-token requests remain compatible.

Official image preparation precedes credential issuance/revocation. Provider error
leaves existing asset unchanged. Actual issuance retains account lock, explicit
reissue confirmation, existing active uniqueness and all Claim/Binding guards.
No schema, Migration, economic transaction, MiniProgram code or flag changes.

VERIFIED 2026-09-08:
- Sweet Card 90/90, POS/Payment 32/32, build PASS, diff check PASS.
- Short-reference proof requirement and revoked/expired rejection tests PASS.
- Official release API capability probe from Production: HTTP200, image277649 bytes,
  check_path=true. Probe used an unassigned random reference; no DB/Claim record created.
- MiniProgram source a1eb519 already decodes scene and sends it through existing
  CloudBase/Gateway contract. No MiniProgram changes required.

NOT VERIFIED: actual phone scan opens released 3.5.1 and Claim page; new-code live resolve.
Production application is unchanged. Public Claim OFF, allowlist-only ON.
Target only SC20268E0640A28E5C / scv-8a9356ee-c07b-4b63-80ed-e252e442dfe3.
Existing active asset1 remains unchanged, balance10 cents. Last reconciled Ledger
700100 cents, delta0; ISSUE10 cents from creating this card is a separate fact.

Next production gate: deploy exact reviewed candidate, preserve flags, reissue only
target presentation through admin, verify old token revoked / new active count1 and
economic digest unchanged, download official code and require real phone scan.
Do not open Public Claim during this gate. No new card, no actual POS charge.
Unknown original budu OS worktree changes preserved/excluded.
Local unpushed commit cannot be recovered on another device through remote Git.
