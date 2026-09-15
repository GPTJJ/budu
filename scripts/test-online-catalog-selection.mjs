import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {createRequire} from 'node:module';
import {enumerateOnlineSkus} from '../server/online-catalog-coverage.js';import {createOnlineCheckout} from '../server/online-checkout.js';
const root=process.env.MINIPROGRAM_SOURCE_ROOT;if(!root)throw Error('MINIPROGRAM_SOURCE_ROOT_REQUIRED');const require=createRequire(import.meta.url);const {resolveOnlineMerchandise}=require(root+'/cloudfunctions/orders/online-catalog.js');
const products=JSON.parse(fs.readFileSync(new URL('../docs/catalog-audit/products.json',import.meta.url))),e=JSON.parse(fs.readFileSync(new URL('../docs/catalog-audit/os-evidence.json',import.meta.url)));
const db={command:{in:x=>x},collection:()=>({where:({id})=>({limit:()=>({get:async()=>({data:products.filter(p=>id.includes(p.id))})})})})};
for(const row of enumerateOnlineSkus(products))test(`${row.productId} ${row.skuId.slice(-8)} catalog -> quote snapshot preserves selection and canonical base`,async()=>{
 const input={productId:row.productId,quantity:row.productId.startsWith('s')?6:1,...(row.choices?{comboFlavors:row.choices.slice().reverse()}: {})};
 const catalog=await resolveOnlineMerchandise(db,[input]);catalog.shippingCents='0';assert.equal(catalog.lines[0].skuId,row.skuId);
 const policy=e.policies.find(p=>p.externalProductId===row.productId&&p.externalSkuId===row.skuId);assert.ok(policy);const product=e.products.find(p=>p.id===policy.productId);assert.ok(product?.isActive);
 const p={user:{findUnique:async()=>({status:'active'})},onlineCheckoutQuote:{findUnique:async()=>null,create:async({data})=>data},onlineSettlement:{findUnique:async()=>null},$executeRaw:async()=>0,onlineProductPolicy:{findUnique:async()=>({...policy,product})},sweetCardCategoryPolicy:{findUnique:async()=>e.blacklist.find(b=>b.categoryId===product.productCategoryId)},weChatAuthIdentity:{findMany:async()=>[{id:'synthetic'}]}};p.$transaction=async f=>f(p);
 const service=createOnlineCheckout(p,{resolveCatalog:async()=>catalog,env:{SWEET_CARD_ONLINE_PAYMENT_ENABLED:'1',SWEET_CARD_ONLINE_PAYMENT_ALLOWLIST:'synthetic'},wechat:{appId:'wx0123456789abcdef',mchId:'1111111111'}});
 const q=await service.quote('synthetic',{requestKey:'catalog-selection-'+row.skuId,lines:catalog.lines.map(l=>({productId:l.productId,skuId:l.skuId,quantity:l.quantity,options:l.options,...(input.comboFlavors?{comboFlavors:input.comboFlavors}:{})})),fulfillment:'PICKUP'});
 const l=q.snapshot.lines[0];assert.equal(l.canonicalProductId,product.id);assert.equal(l.productId,input.productId);assert.equal(l.name,products.find(p=>p.id===input.productId).name);assert.deepEqual(l.options,catalog.lines[0].options);assert.deepEqual(l.comboFlavors,input.comboFlavors??null);assert.equal(l.onlineEligible,true);
 if(input.comboFlavors){assert.equal(product.sku,'BUDU-BALLS-BOX-4');assert.equal(l.unitPriceCents,'29900');assert.deepEqual(q.snapshot.commerceIntent.lines[0].comboFlavors,input.comboFlavors)}
 if(row.productId.startsWith('s'))assert.equal(product.sku,'BUDU-CANDY-01');
});
