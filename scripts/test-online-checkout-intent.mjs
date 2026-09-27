import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeOnlineCheckoutIntent as normalize } from '../server/online-checkout-intent.js'
const input = () => ({ lines: [{ productId:'combo', skuId:'sku', quantity:1,
  options:['礼盒','杏仁'], comboFlavors:['almond','almond'] }], fulfillment:'PICKUP', storeRef:'store-1' })
test('legacy no-selection normalized bytes remain compatible with persisted request fingerprints',()=>{
 const value={lines:[{productId:'p',skuId:'s',quantity:1}],fulfillment:'PICKUP'}
 const old={lines:value.lines,fulfillment:'PICKUP',addressRef:null,walletRef:null,desiredSweetCardCents:'0'}
 assert.equal(JSON.stringify(normalize(value)),JSON.stringify(old))
 assert.equal(JSON.stringify(normalize({...value,storeRef:null,lines:[{...value.lines[0],options:[],comboFlavors:null}]})),JSON.stringify(old))
})
test('preserves independently copied selections, combo multiplicity and stable store reference',()=>{
 const value=input(), result=normalize(value)
 assert.deepEqual(result.lines[0].comboFlavors,['almond','almond'])
 assert.deepEqual(result.lines[0].options,['礼盒','杏仁'])
 assert.equal(result.storeRef,'store-1')
 value.lines[0].options[0]='changed'; value.lines[0].comboFlavors.pop()
 assert.equal(result.lines[0].options[0],'礼盒');assert.equal(result.lines[0].comboFlavors.length,2)
})
test('selection or store changes affect normalized idempotency input; client prices are discarded',()=>{
 const a=input(), b=input();b.lines[0].comboFlavors=['almond','walnut']
 assert.notEqual(JSON.stringify(normalize(a)),JSON.stringify(normalize(b)))
 b.lines=a.lines;b.storeRef='store-2'
 assert.notEqual(JSON.stringify(normalize(a)),JSON.stringify(normalize(b)))
 assert.deepEqual(normalize({...a,totalCents:'1',lines:[{...a.lines[0],unitPriceCents:'1',onlineEligible:true}]}),normalize(a))
})
test('malformed or unbounded selections fail closed instead of being silently discarded',()=>{
 for(const change of [{options:{}},{options:[null]},{options:[' ']},{options:['x'.repeat(121)]},{options:Array(33).fill('x')},{comboFlavors:[{}]},{comboFlavors:Array(101).fill('x')}]){
  const value=input();Object.assign(value.lines[0],change);assert.throws(()=>normalize(value),{status:400})
 }
 assert.throws(()=>normalize({...input(),storeRef:{id:'store'}}),{status:400})
})
