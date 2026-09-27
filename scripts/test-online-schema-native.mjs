import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
// Explicit opt-in, loopback-only synthetic database. Never defaults to DATABASE_URL.
const configPath=process.env.SC11B_NATIVE_CONFIG;
if(!configPath) throw Error('SC11B_NATIVE_CONFIG required');
const config=JSON.parse(fs.readFileSync(configPath));
if(config.host!=='127.0.0.1'||config.database!=='budu_sc11b_native') throw Error('ISOLATED_NATIVE_DB_REQUIRED');
const require=createRequire(import.meta.url);
const {Client}=require(process.env.SC11B_NATIVE_PG_MODULE||'pg');
async function fixture(fn,{tender=true,quoteTotal='110'}={}) {
 const c=new Client(config); await c.connect();
 const id=randomUUID();
 try {
  assert.match((await c.query('SHOW server_version')).rows[0].server_version,/^16\./);
  await c.query('BEGIN');
  await c.query('INSERT INTO "User" (id,username,"passwordHash") VALUES ($1,$1,$2)',[id,'synthetic-not-a-password']);
  await c.query("INSERT INTO online_checkout_quotes(id,user_id,request_key,request_fingerprint,snapshot,expires_at) VALUES($1,$1,$1,$1,$2,now()+interval '15 minutes')",[id,JSON.stringify({currency:'CNY',merchandiseCents:'100',eligibleMerchandiseCents:'100',shippingCents:'10',totalCents:quoteTotal,sweetCardCents:'0',wechatCents:'110'})]);
  await c.query("INSERT INTO online_settlements(id,user_id,quote_id,namespace,external_order_id,request_key,request_fingerprint,merchandise_cents,eligible_merchandise_cents,shipping_cents,total_cents,sweet_card_cents,wechat_cents,expires_at) VALUES($1,$1,$1,'native-test',$1,$1,$1,100,100,10,110,0,110,now()+interval '15 minutes')",[id]);
  if(tender) await c.query("INSERT INTO online_tenders(id,settlement_id,type,amount_cents,merchant_trade_no) VALUES($1,$1,'WECHAT',110,$1)",[id]);
  await fn(c,id);
 } finally {await c.query('ROLLBACK');await c.end();}
}
test('native deferred constraints accept consistent pending WX-only settlement',()=>fixture(async c=>{await c.query('SET CONSTRAINTS ALL IMMEDIATE');}));
test('native commit-time validation rejects missing tender',()=>fixture(async c=>{await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_TENDER_RECONCILIATION'});},{tender:false}));
test('native trigger rejects immutable monetary rewrite',()=>fixture(async(c,id)=>{await assert.rejects(c.query('UPDATE online_settlements SET total_cents=111,wechat_cents=111 WHERE id=$1',[id]),{code:'23514',message:'ONLINE_IMMUTABLE_FACT'});}));
test('native deferred validation rejects PAID without verified tender',()=>fixture(async(c,id)=>{await c.query("UPDATE online_settlements SET version=version+1,status='PAID',paid_at=now() WHERE id=$1",[id]);await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_UNVERIFIED_PAID_STATE'});}));
test('native unique identity rejects duplicate tender',()=>fixture(async(c,id)=>{await assert.rejects(c.query("INSERT INTO online_tenders(id,settlement_id,type,amount_cents,merchant_trade_no) VALUES($2,$1,'WECHAT',110,$2)",[id,randomUUID()]),{code:'23505'});}));
test('native transition denies pending straight to refunded',()=>fixture(async(c,id)=>{await assert.rejects(c.query("UPDATE online_settlements SET version=version+1,status='REFUNDED' WHERE id=$1",[id]),{code:'23514',message:'ONLINE_STATE_TRANSITION_DENIED'});}));
test('native immutable quote cannot be deleted',()=>fixture(async(c,id)=>{await assert.rejects(c.query('DELETE FROM online_checkout_quotes WHERE id=$1',[id]),{code:'23514',message:'ONLINE_FINANCIAL_DELETE_DENIED'});}));
test('native refund status requires actual settled refund facts',()=>fixture(async(c,id)=>{
 await c.query("UPDATE online_tenders SET status='SUCCEEDED',verified_at=now(),provider_transaction_id=$1,provider_success_at=now() WHERE id=$1",[id]);
 await c.query("UPDATE online_settlements SET version=version+1,status='PAID',paid_at=now() WHERE id=$1",[id]);
 await c.query("UPDATE online_settlements SET version=version+1,status='REFUNDED' WHERE id=$1",[id]);
 await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_REFUND_STATE_MISMATCH'});
}));
async function received(c,id){await c.query("UPDATE online_tenders SET status='SUCCEEDED',verified_at=now(),provider_transaction_id=$1,provider_success_at=now() WHERE id=$1",[id]);}
async function compensate(c,id,amount=110){await c.query("INSERT INTO online_payment_compensations(id,settlement_id,provider_transaction_id,amount_cents,reason,merchant_refund_no) VALUES($1,$1,$1,$2,'LATE_PAYMENT',$1)",[id,amount]);}
test('native quote and settlement monetary mismatch denied',()=>fixture(async c=>{
 await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_QUOTE_AMOUNT_MISMATCH'});
},{quoteTotal:'111'}));
test('native compensation cannot precede verified payment',()=>fixture(async(c,id)=>{
 await c.query("UPDATE online_settlements SET version=version+1,status='RECONCILIATION_REQUIRED' WHERE id=$1",[id]);await compensate(c,id);
 await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_COMPENSATION_MISMATCH'});
}));
test('native late payment requires durable compensation',()=>fixture(async(c,id)=>{
 await received(c,id);await c.query("UPDATE online_settlements SET version=version+1,status='RECONCILIATION_REQUIRED' WHERE id=$1",[id]);
 await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_RECEIVED_PAYMENT_WITHOUT_COMPENSATION'});
}));
test('native compensation amount must equal actual received WX tender',()=>fixture(async(c,id)=>{
 await received(c,id);await c.query("UPDATE online_settlements SET version=version+1,status='RECONCILIATION_REQUIRED' WHERE id=$1",[id]);await compensate(c,id,109);
 await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_COMPENSATION_MISMATCH'});
}));
test('native verified late payment with pending compensation accepted',()=>fixture(async(c,id)=>{
 await received(c,id);await c.query("UPDATE online_settlements SET version=version+1,status='RECONCILIATION_REQUIRED' WHERE id=$1",[id]);await compensate(c,id);
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');
}));
async function cardFixture(fn){
 const c=new Client(config);await c.connect();const id=randomUUID();
 try{
  await c.query('BEGIN');
  await c.query('INSERT INTO "User"(id,username,"passwordHash") VALUES($1,$1,\'synthetic\')',[id]);
  await c.query("INSERT INTO sweet_card_accounts(id,public_card_no,initial_amount_cents,balance_cents,validity_type,carrier_type,binding_mode,status) VALUES($1,$1,100,100,'LONG_TERM','ELECTRONIC','REQUIRED','ACTIVE')",[id]);
  await c.query("INSERT INTO sweet_card_ledger(id,account_id,type,amount_cents,balance_after_cents,request_key) VALUES($2,$1,'ISSUE',100,100,$2)",[id,randomUUID()]);
  const snapshot={currency:'CNY',merchandiseCents:'100',eligibleMerchandiseCents:'100',shippingCents:'0',totalCents:'100',sweetCardCents:'100',wechatCents:'0'};
  await c.query("INSERT INTO online_checkout_quotes(id,user_id,request_key,request_fingerprint,snapshot,expires_at) VALUES($1,$1,$1,$1,$2,now()+interval '15 minutes')",[id,JSON.stringify(snapshot)]);
  await c.query("INSERT INTO online_settlements(id,user_id,quote_id,namespace,external_order_id,request_key,request_fingerprint,account_id,merchandise_cents,eligible_merchandise_cents,shipping_cents,total_cents,sweet_card_cents,wechat_cents,expires_at) VALUES($1,$1,$1,'native-test',$1,$1,$1,$1,100,100,0,100,100,0,now()+interval '15 minutes')",[id]);
  await c.query("INSERT INTO online_tenders(id,settlement_id,type,amount_cents) VALUES($1,$1,'SWEET_CARD',100)",[id]);
  await c.query("INSERT INTO sweet_card_reservations(id,settlement_id,account_id,user_id,request_key,amount_cents,expires_at) VALUES($1,$1,$1,$1,$1,100,now()+interval '15 minutes')",[id]);
  await fn(c,id);
 }finally{await c.query('ROLLBACK');await c.end();}
}
async function capture(c,id,{updateBalance=true,status='PAID'}={}){
 const ledger=randomUUID();
 await c.query("INSERT INTO sweet_card_ledger(id,account_id,type,amount_cents,balance_after_cents,request_key) VALUES($2,$1,'REDEEM',-100,0,$2)",[id,ledger]);
 await c.query("UPDATE sweet_card_reservations SET status='CAPTURED',captured_at=now() WHERE id=$1",[id]);
 await c.query("UPDATE online_tenders SET status='SUCCEEDED',verified_at=now() WHERE id=$1",[id]);
 await c.query("UPDATE online_settlements SET status=$3,version=version+1,paid_at=now(),captured_ledger_id=$2 WHERE id=$1",[id,ledger,status]);
 if(updateBalance)await c.query("UPDATE sweet_card_accounts SET balance_cents=0,status='EXHAUSTED' WHERE id=$1",[id]);
}
test('native reservation does not require economic debit',()=>cardFixture(async c=>{await c.query('SET CONSTRAINTS ALL IMMEDIATE');}));
test('native capture ledger without balance debit is rejected',()=>cardFixture(async(c,id)=>{
 await capture(c,id,{updateBalance:false});await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_LEDGER_BALANCE_MISMATCH'});
}));
test('native capture with matching balance accepted',()=>cardFixture(async(c,id)=>{await capture(c,id);await c.query('SET CONSTRAINTS ALL IMMEDIATE');}));
test('native captured funds cannot enter unpaid reconciliation',()=>cardFixture(async(c,id)=>{
 await capture(c,id,{status:'RECONCILIATION_REQUIRED'});await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_RESERVATION_STATE_MISMATCH'});
}));
test('native settlement version cannot decrease',()=>fixture(async(c,id)=>{
 await c.query('UPDATE online_settlements SET version=2 WHERE id=$1',[id]);
 await assert.rejects(c.query('UPDATE online_settlements SET version=1 WHERE id=$1',[id]),{code:'23514',message:'ONLINE_VERSION_TRANSITION_DENIED'});
}));
test('native WX success requires provider payment time',()=>fixture(async(c,id)=>{
 await assert.rejects(c.query("UPDATE online_tenders SET status='SUCCEEDED',verified_at=now(),provider_transaction_id=$1 WHERE id=$1",[id]),{code:'23514'});
}));
async function refundCard(c,id,updateBalance){
 const refund=randomUUID(),ledger=randomUUID();
 await c.query("INSERT INTO sweet_card_ledger(id,account_id,type,amount_cents,balance_after_cents,request_key) VALUES($2,$1,'REFUND',100,100,$2)",[id,ledger]);
 await c.query("INSERT INTO online_refunds(id,settlement_id,request_key,request_fingerprint,sequence,status,eligible_cents,ineligible_cents,shipping_cents,total_cents,sweet_card_cents,wechat_cents,cumulative_eligible_cents,cumulative_card_cents,items,credited_ledger_id,settled_at,created_by_id) VALUES($2,$1,$2,$2,1,'SETTLED',100,0,0,100,100,0,100,100,'[]',$3,now(),$1)",[id,refund,ledger]);
 await c.query("UPDATE online_settlements SET status='REFUNDED',version=version+1 WHERE id=$1",[id]);
 if(updateBalance)await c.query("UPDATE sweet_card_accounts SET balance_cents=100,status='ACTIVE' WHERE id=$1",[id]);
}
test('native refund ledger without balance credit is rejected',()=>cardFixture(async(c,id)=>{
 await capture(c,id);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('SET CONSTRAINTS ALL DEFERRED');
 await refundCard(c,id,false);await assert.rejects(c.query('SET CONSTRAINTS ALL IMMEDIATE'),{code:'23514',message:'ONLINE_LEDGER_BALANCE_MISMATCH'});
}));
test('native source-correct full card refund reconciles',()=>cardFixture(async(c,id)=>{
 await capture(c,id);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await c.query('SET CONSTRAINTS ALL DEFERRED');
 await refundCard(c,id,true);await c.query('SET CONSTRAINTS ALL IMMEDIATE');
 const fact=await c.query('SELECT (SELECT balance_cents FROM sweet_card_accounts WHERE id=$1) AS balance, (SELECT sum(amount_cents) FROM sweet_card_ledger WHERE account_id=$1) AS ledger',[id]);
 assert.deepEqual(fact.rows[0],{balance:'100',ledger:'100'});
}));
test('native SETTLED compensation requires non-null provider SUCCESS',()=>fixture(async(c,id)=>{
 await received(c,id);await c.query("UPDATE online_settlements SET status='RECONCILIATION_REQUIRED',version=version+1 WHERE id=$1",[id]);await compensate(c,id);
 await assert.rejects(c.query("UPDATE online_payment_compensations SET status='SETTLED',verified_at=now(),settled_at=now(),provider_refund_id=$1,provider_status=NULL WHERE id=$1",[id]),{code:'23514'});
}));
test('native SETTLED WX refund requires non-null provider SUCCESS',()=>fixture(async(c,id)=>{
 await received(c,id);await c.query("UPDATE online_settlements SET status='PAID',paid_at=now(),version=version+1 WHERE id=$1",[id]);
 await assert.rejects(c.query("INSERT INTO online_refunds(id,settlement_id,request_key,request_fingerprint,sequence,status,eligible_cents,ineligible_cents,shipping_cents,total_cents,sweet_card_cents,wechat_cents,cumulative_eligible_cents,cumulative_card_cents,items,merchant_refund_no,provider_refund_id,verified_at,settled_at,created_by_id) VALUES($1,$1,$1,$1,1,'SETTLED',100,0,10,110,0,110,100,0,'[]',$1,$1,now(),now(),$1)",[id]),{code:'23514'});
}));
test('native completed compensation cannot clear provider SUCCESS',()=>fixture(async(c,id)=>{
 await received(c,id);await c.query("UPDATE online_settlements SET status='RECONCILIATION_REQUIRED',version=version+1 WHERE id=$1",[id]);await compensate(c,id);
 await c.query("UPDATE online_payment_compensations SET status='SETTLED',verified_at=now(),settled_at=now(),provider_refund_id=$1,provider_status='SUCCESS' WHERE id=$1",[id]);
 await c.query('SET CONSTRAINTS ALL IMMEDIATE');
 await assert.rejects(c.query('UPDATE online_payment_compensations SET provider_status=NULL WHERE id=$1',[id]),{code:'23514'});
}));
