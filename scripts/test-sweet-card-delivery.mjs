import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { createDeliveryPackage, saveDeliveryFile } from '../src/utils/sweetCardDelivery.js'

test('package has PNG and UTF-8 proof text; never embeds proof in image', async () => {
 const bytes = new Uint8Array([137,80,78,71])
 const blob = await createDeliveryPackage(new Blob([bytes]), 'SYNTHETIC_PROOF_ONLY')
 const zip = await JSZip.loadAsync(await blob.arrayBuffer())
 assert.deepEqual(Object.keys(zip.files).sort(), ['电子卡.png','领取凭证.txt'].sort())
 assert.deepEqual(await zip.file('电子卡.png').async('uint8array'),bytes)
 assert.match(await zip.file('领取凭证.txt').async('string'), /SYNTHETIC_PROOF_ONLY/)
})
test('missing proof cannot generate misleading incomplete package', async () => {
 await assert.rejects(createDeliveryPackage(new Blob(), ''), /PROOF_UNAVAILABLE/)
})
test('share receives prepared file synchronously in user gesture', async () => {
 let called = false
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{canShare:()=>true,share:({files})=>{called=files[0].name==='card.zip';return Promise.resolve()}}})
 const pending=saveDeliveryFile(new File(['fixture'],'card.zip'))
 assert.equal(called,true);await pending
})
test('cancel is preserved for visible UI feedback; no download fallback', async () => {
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{canShare:()=>true,share:()=>Promise.reject(new DOMException('cancel','AbortError'))}})
 await assert.rejects(saveDeliveryFile(new File(['fixture'],'card.zip')),e=>e.name==='AbortError')
})
test('share failure is preserved, not silently reported as saved', async () => {
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{canShare:()=>true,share:()=>Promise.reject(new Error('failure'))}})
 await assert.rejects(saveDeliveryFile(new File(['fixture'],'card.zip')))
})
