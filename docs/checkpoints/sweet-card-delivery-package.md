# Sweet Card delivery package candidate

Base: 9f6da26b2efa2c08eb7c24cfb4eb27fc3e9b4f47. Branch codex/sweet-card-delivery-package.

Video evidence: iPhone Home Screen web app opens blank data: viewer after card generation. Source used data:image/svg+xml navigation and anchor download. This candidate replaces that with local PNG canvas conversion, inline expanded preview and prepared File sharing/download. ZIP contains 电子卡.png and 领取凭证.txt. Existing jszip dependency reused.

Proof stays in delivery component memory only; copy retains existing parent clear behavior, clears prepared ZIP and disables package. Close unmounts; revoke disables export. No server recovery, automatic reissue, new credential, or persistent browser storage. Errors/cancellation visible in current overlay. Administrator bundle contains full claim materials; UI instructs separate delivery to recipient.

VERIFIED: build PASS; Sweet Card90/90; export unit5/5; existing admin WebKit9/9 (share API stub for automated file-handoff assertions); local WebKit inline preview and320/340/375/390/430/768 widths PASS; share cancellation and copy/package invalidation PASS.

UNVERIFIED: actual iPhone Home Screen system share/save-to-Files completion. Candidate requires real-device test after separately authorized deployment. Unsupported share uses blob download with visible Safari fallback guidance; not reported as guaranteed saved.

No backend/API/schema/Migration/payment/refund/redemption/ledger changes. Production mutation NONE. No push or deployment.
