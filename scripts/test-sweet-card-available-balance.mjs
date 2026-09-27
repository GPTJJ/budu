import test from 'node:test'
import assert from 'node:assert/strict'
import { sweetCardAvailableBalance } from '../server/sweet-card-available-balance.js'
function db(amount){return {sweetCardReservation:{aggregate:async args=>{
 assert.deepEqual(args,{where:{accountId:'card',status:'RESERVED'},_sum:{amountCents:true}})
 return {_sum:{amountCents:amount}}
}}}}
test('POS available balance subtracts all active holds',async()=>assert.deepEqual(await sweetCardAvailableBalance(db(40n),{id:'card',balanceCents:100n}),{balanceCents:100n,reservedCents:40n,availableCents:60n}))
test('zero holds preserve full legacy balance',async()=>assert.equal((await sweetCardAvailableBalance(db(null),{id:'card',balanceCents:100n})).availableCents,100n))
test('fully reserved card has zero spendable balance',async()=>assert.equal((await sweetCardAvailableBalance(db(100n),{id:'card',balanceCents:100n})).availableCents,0n))
test('inconsistent holds fail closed',async()=>assert.rejects(sweetCardAvailableBalance(db(101n),{id:'card',balanceCents:100n}),{status:409}))
test('missing reservation service never defaults to full balance',async()=>assert.rejects(sweetCardAvailableBalance({}, {id:'card',balanceCents:100n}),{status:503}))
