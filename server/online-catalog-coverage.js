import crypto from 'node:crypto'

export function enumerateOnlineSkus(products) {
  const rows = [], ids = new Set()
  for (const p of products) {
    if (p.status !== 'on') continue
    if (typeof p.id !== 'string' || !p.id || ids.has(p.id)) throw Error('ONLINE_CATALOG_IDENTITY_CONFLICT')
    ids.add(p.id)
    const add = choices => rows.push({ productId:p.id, skuId:'sku-'+crypto.createHash('sha256').update(JSON.stringify([p.id,choices])).digest('hex'), choices })
    if (!p.combo) { add(null); continue }
    const {slots,repeat,flavorIds}=p.combo
    if (!Number.isInteger(slots)||slots<1||slots>100||typeof repeat!=='boolean'||!Array.isArray(flavorIds)||!flavorIds.length||new Set(flavorIds).size!==flavorIds.length) throw Error('ONLINE_CATALOG_COMBO_INVALID')
    const flavors=flavorIds.filter(id=>products.some(x=>x.id===id&&x.status==='on')).sort()
    const begin=rows.length
    const visit=(selected,start)=>{
      if(rows.length>100000)throw Error('ONLINE_CATALOG_ENUMERATION_LIMIT')
      if(selected.length===slots){add(selected);return}
      for(let i=start;i<flavors.length;i++)visit([...selected,flavors[i]],repeat?i:i+1)
    }
    visit([],0)
    if(rows.length===begin)throw Error('ONLINE_CATALOG_COMBO_UNSELLABLE')
  }
  return rows
}

export function classifyOnlinePolicy(policy,blocked) {
  if(!policy?.productId||!policy.product||policy.product.id!==policy.productId||policy.product.isActive!==true)
    return {status:'MAPPING_REQUIRES_CONFIRMATION',reason:'VALID_CANONICAL_MAPPING_REQUIRED',allowed:false}
  if(blocked?.blocked===true)return {status:'MAPPED_BLACKLISTED',allowed:false}
  if(policy.enabled!==true)return {status:'MAPPING_REQUIRES_CONFIRMATION',reason:'EXPLICIT_POLICY_DECISION_REQUIRED',allowed:false}
  return {status:'MAPPED_ELIGIBLE',allowed:true}
}

export function auditOnlineCatalog({products,policies,canonicalProducts,blacklist,namespace='cloudbase-miniprogram'}) {
  const rows=enumerateOnlineSkus(products).map(row=>{
    const found=policies.filter(p=>p.namespace===namespace&&p.externalProductId===row.productId&&p.externalSkuId===row.skuId)
    if(found.length>1)throw Error('ONLINE_POLICY_IDENTITY_CONFLICT')
    const policy=found[0],product=canonicalProducts.find(p=>p.id===policy?.productId)
    const decision=classifyOnlinePolicy(policy?{...policy,product}:null,blacklist.find(b=>b.categoryId===product?.productCategoryId))
    return {...row,...decision,canonicalProductId:product?.id??null}
  })
  const eligible=rows.filter(r=>r.status==='MAPPED_ELIGIBLE').length,blocked=rows.filter(r=>r.status==='MAPPED_BLACKLISTED').length
  return {gate:'SC_ONLINE_CATALOG_COVERAGE',status:rows.length===eligible+blocked?'PASS':'RELEASE_BLOCKED',active:rows.length,eligible,blacklisted:blocked,unmapped:rows.length-eligible-blocked,rows}
}
