-- P0 READ-ONLY inspection (snake_case production columns). SELECT only.
\pset pager off

\echo '=== A. target order by payNo ==='
SELECT s.id, s.status, s.reconciliation_reason, s.version,
       s.total_cents, s.sweet_card_cents, s.wechat_cents,
       s.expires_at, s.paid_at, s.cancelled_at, s.created_at, s.updated_at
FROM online_settlements s
WHERE s.id IN (SELECT settlement_id FROM online_tenders WHERE merchant_trade_no = 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70')
   OR s.id = 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70'
   OR s.external_order_id = 'Bf7d39d62fbfb5e5d9ed4f12c8d42d70';

\echo '=== B. ALL settlements (dataset is tiny) ==='
SELECT s.id, s.status, s.reconciliation_reason AS reason, s.version,
       s.wechat_cents AS wx, s.sweet_card_cents AS sc, s.total_cents AS total,
       s.expires_at, s.paid_at, s.cancelled_at, s.created_at, s.updated_at
FROM online_settlements s
ORDER BY s.created_at ASC;

\echo '=== C. ALL tenders ==='
SELECT t.id, t.settlement_id, t.type, t.status, t.amount_cents,
       t.merchant_trade_no, t.prepay_id IS NOT NULL AS has_prepay,
       t.prepay_requested_at, t.provider_transaction_id IS NOT NULL AS has_txn,
       t.created_at, t.updated_at
FROM online_tenders t
ORDER BY t.created_at ASC;

\echo '=== D. ALL reservations ==='
SELECT r.id, r.settlement_id, r.status, r.amount_cents, r.expires_at,
       r.captured_at, r.released_at, r.created_at
FROM sweet_card_reservations r
ORDER BY r.created_at ASC;

\echo '=== E. stuck roll-up ==='
SELECT s.status,
       count(*) AS n,
       count(*) FILTER (WHERE s.expires_at < now()) AS expired,
       min(s.created_at) AS oldest,
       max(s.created_at) AS newest
FROM online_settlements s
GROUP BY s.status
ORDER BY s.status;

\echo '=== F. tender prepay matrix for open holds ==='
SELECT s.status AS settlement_status,
       t.status AS tender_status,
       (t.prepay_requested_at IS NOT NULL) AS prepay_attempted,
       (t.prepay_id IS NOT NULL) AS has_prepay_id,
       (t.provider_transaction_id IS NOT NULL) AS has_provider_txn,
       count(*) AS n
FROM online_tenders t
JOIN online_settlements s ON s.id = t.settlement_id
WHERE t.type = 'WECHAT'
GROUP BY 1, 2, 3, 4, 5
ORDER BY n DESC;

\echo '=== G. reconciliation counts ==='
SELECT
  (SELECT count(*) FROM online_settlements WHERE status IN ('PENDING','CLOSING')) AS open_holds,
  (SELECT count(*) FROM online_settlements WHERE status = 'RECONCILIATION_REQUIRED') AS recon_required,
  (SELECT count(*) FROM sweet_card_reservations WHERE status = 'RESERVED') AS active_reservations,
  (SELECT count(*) FROM sweet_card_reservations WHERE status = 'RESERVED' AND expires_at < now()) AS overdue_reservations,
  (SELECT count(*) FROM online_settlements WHERE status = 'PAID') AS paid;
