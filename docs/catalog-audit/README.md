# SC_ONLINE_CATALOG_COVERAGE — 2026-09-15

Production authority read directly: CloudBase budu-d6gz358ixe39faf43; OS runtime 01faa20, DB budu_bj006.
Read scope: 28 active products; 27 fixed SKUs and 126 multiset variants for bb (4 selections from 6 flavors, repeats allowed), total 153.

## Verified data fixes

Inspected production product photographs alongside MiniProgram package cover assets selected by current catalogue. Explicit individual decisions in applied-mapping-plan.json use image, price, product description, active identity and uniqueness together. No runtime name matching introduced. 11 mappings inserted in one guarded transaction. Existing c1 and user-confirmed g12 unchanged. Current mapped eligible:13, mapped blacklisted:0, requires confirmation:140.
Production before-image / guarded rollback: writer /tmp/sc-catalog-before-20260915.json and /tmp/sc-catalog-rollback-20260915.sql. Ledger and balance both 1320110 cents before/after; ledger rows 53. No captures, refunds, reservations, order submissions or payments created. Two quotes created using freshly read CloudBase catalogue through existing resolver/pricing and production checkout service. This is service-level authoritative quote verification, not a new client/gateway E2E.
Basket g12*1 + g24*2: total/eligible=32700, card available=50000, shipping=0; selected card tender=32700, WeChat=0; without card WeChat=32700.

## Confirmation required (one consolidated business review)

- g8f/g8l: both retail 4900; label says square/long respectively but photos disagree with corresponding OS square/long records. Do not select a mapping using name alone.
- s1-s12: twelve flavor products, 500 cents/6g each. OS has active generic BUDU-CANDY-01 (1颗-零售,500); flavor-specific raw/inventory records are inactive. Does a MiniProgram flavor selection represent the generic retail candy financial product, with flavor retained as item intent? No mapping assumed.
- bb: 29900 for four selected flavors; 126 stable variants. No active matching OS retail gift-set found. The packaging/material record is inactive and is not a valid retail identity. A valid canonical retail product and its business identity are required. No new product was created.

## Permanent gate candidate — NOT DEPLOYED

server/online-catalog-coverage.js enumerates all sellable SKU variants and produces only MAPPED_ELIGIBLE / MAPPED_BLACKLISTED / MAPPING_REQUIRES_CONFIRMATION. scripts/check-online-catalog-coverage.mjs consumes fresh authority snapshots and exits nonzero if coverage incomplete. Checked-in snapshots are evidence only, never a replacement for fresh production inventory at later release gates.
server/online-checkout.js candidate rejects unresolved/inactive/disabled non-blacklist mappings before issuing new quotes (ONLINE_CATALOG_COVERAGE_REQUIRED); mapped blacklist remains false. No allocation calculation changed. Not deployed: turning this on with 140 unresolved SKUs would block those orders. Production still uses the old default-deny behavior for unresolved products; do not claim permanent runtime enforcement is live yet.
Run: node scripts/check-online-catalog-coverage.mjs docs/catalog-audit/products.json docs/catalog-audit/os-evidence.json
Current result: RELEASE_BLOCKED, expected exit 1.
Run: node --test scripts/test-online-catalog-coverage.mjs scripts/test-online-checkout-policy.mjs
Result:23/23 PASS; covers enumeration, missing mapping, inactive, blacklist, mixed eligible/blacklist, insufficient/sufficient balance, shipping and zero-cent reconciliation.
MiniProgram code changed:NO. MiniProgram upload/review:NO. OS candidate source changes only; deployment pending full coverage.

## Final closure (supersedes incomplete coverage above)

User explicitly confirmed both 8-piece packaging identities, the 12 candy flavors -> BUDU-CANDY-01 base-product relationship, and creation of one Balls retail base. No name-derived runtime mapping was introduced.

Created ONE active retail InventoryItem: it-fb77c912-793c-428c-a200-b4f873594496 / BUDU-BALLS-BOX-4 / Balls 自选四款礼盒 / 29900 cents / 盒 / 4款自由搭配/盒 / category 巧克力豆. Existing CloudBase bb remains online; no separate OS online-sale field exists, online participation is represented by the explicit OnlineProductPolicy mappings.
140 mappings created transactionally: g8f,g8l, s1-s12, all126 bb variants. No historical inactive record re-enabled; gift/material products untouched. Database retains distinct external stable SKU configurations referencing the SAME Balls base Product/SKU.
Fresh production policy snapshot: active153, eligible153, blacklisted0, unmapped0, ambiguous0. All-active-skus.csv lists every configuration. Ledger total and balances remain1320110 cents, ledger rows53; no financial mutation. Before-image and rollback are /tmp/sc-catalog-final-before-20260915.json and /tmp/sc-catalog-final-rollback-20260915.sql inside current writer.
Tests: MINIPROGRAM_SOURCE_ROOT=/Users/apple/Desktop/budu-miniprogram-refund-routing node --test scripts/test-online-catalog-selection.mjs scripts/test-online-catalog-coverage.mjs scripts/test-online-checkout-policy.mjs ->176/176 PASS. 153 tests call existing CloudBase catalog resolver and actual checkout quote service with an isolated test database adapter; verify canonical product, flavor productId/name, options and combination order/multiplicity. No production order/payment generated by these tests.
Coverage CLI exits0 on the fresh153-SKU snapshot. Runtime coverage rejection is still CANDIDATE ONLY (not deployed); this data closure does not claim new runtime enforcement is live. Future release checks must supply fresh production catalogue/policy snapshots; stale checked-in evidence is insufficient.
PRODUCT_MEDIA_DATA_ISSUE: g8f/g8l imagery is inconsistent with confirmed square/long identities. Identity follows user-confirmed packaging, media unchanged; separate future correction only.

## Runtime guard release preparation

2026-09-15: deployment explicitly authorized. New quote policy failures return HTTP409 CATALOG_MAPPING_REQUIRED (including signed gateway API serialization), before any quote or financial write. Production fresh catalog153/153, native migrations73/0, one writer, backup verified at /opt/budu/.rollback-assets/catalog-guard-20260915/baseline-m73.dump. Production financial baseline ledger/balance1320110, reconciliation0, duplicate links0, orphan/expired reservations0. Regression182/182 including authenticated loopback HTTP rejection; production build PASS. Code-only rollout retains previous writer/image and nginx configuration; no schema change and no public flags changed.
