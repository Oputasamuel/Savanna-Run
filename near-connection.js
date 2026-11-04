(function () {
 'use strict';
 const config = window.SavannaNearConfig || {};
 const key = 'savanna.near.pending.v1';
 const skuKey = 'savanna.near.sku.v1';
 let selectorPromise, busy = false, accessToken = '';
 const send = (method, value) => window.SavannaUnityInstance?.SendMessage('Savanna Supabase Client', method, value || '');
 function setPurchaseMessage(message, kind) { send('SetNearPurchaseMessageFromWeb', `${kind}|${message}`); }
 async function selector() {
  if (!config.contractId || !['testnet','mainnet'].includes(config.networkId)) throw new Error('NEAR checkout is not configured yet');
  selectorPromise ||= Promise.all([
   import('https://esm.sh/@near-wallet-selector/core@10.1.4'),
   import('https://esm.sh/@near-wallet-selector/my-near-wallet@10.1.4')
  ]).then(([core, wallet]) => core.setupWalletSelector({network:config.networkId,modules:[wallet.setupMyNearWallet()]}));
  return selectorPromise;
 }
 async function prepare(sku) {
  const s = await selector();
  let accounts = s.store.getState().accounts;
  if (!accounts.length) {
   sessionStorage.setItem(skuKey,sku);
   const wallet = await s.wallet('my-near-wallet');
   await wallet.signIn({contractId:config.contractId,methodNames:[]});
   accounts = s.store.getState().accounts;
   if (!accounts.length) return; // Redirect wallet resumes on page return.
  }
  sessionStorage.removeItem(skuKey);
  send('BeginNearSkuPurchaseFromWeb', `${sku}|${accounts[0].accountId}`);
 }
 function requestSkuPurchase(sku) {
  if (busy || !['orb_1','dagbe_pack','kesi_upgrade_01','dagbe_upgrade_01'].includes(sku)) return false;
  busy = true;
  (async()=>{
   try {
    const pending = JSON.parse(sessionStorage.getItem(key)||'null');
    if(pending) {
     if(pending.hash) { send('ResumeNearPurchaseFromWeb'); return; }
     throw new Error('A payment is awaiting its wallet result. Return from your wallet before starting another payment.');
    }
    await prepare(sku);
   } catch(e) { busy=false; setPurchaseMessage(e.message || 'NEAR wallet connection failed',3); }
  })();
  return true;
 }
 async function verify(pending) {
  for(let attempt=0;attempt<12;attempt++) {
   const response=await fetch(config.supabaseUrl+'/functions/v1/verify-near-purchase',{
    method:'POST',headers:{'Content-Type':'application/json',apikey:config.publishableKey,Authorization:'Bearer '+accessToken},
    body:JSON.stringify({intent_id:pending.intent.intent_id,tx_hash:pending.hash})
   });
   const result=await response.json();
   if(response.ok&&result.ok){ sessionStorage.removeItem(key);send('OnNearPurchaseResult',JSON.stringify(result));setPurchaseMessage('PURCHASE CONFIRMED',1);busy=false;return; }
   if([401,403,404].includes(response.status))throw new Error(result.error||'Payment could not be verified');
   await new Promise(resolve=>setTimeout(resolve,1500));
  }
  throw new Error('Payment verification is pending. Your payment reference is saved; retry to check it again.');
 }
 async function cancelReservation(pending) {
  if(!pending?.intent?.intent_id || !accessToken)return;
  try {
   await fetch(config.supabaseUrl+'/rest/v1/rpc/cancel_near_purchase',{
    method:'POST',headers:{'Content-Type':'application/json',apikey:config.publishableKey,Authorization:'Bearer '+accessToken},
    body:JSON.stringify({p_intent_id:pending.intent.intent_id})
   });
  } catch(_) { /* Expiry cleanup is the server-side fallback. */ }
 }
 async function startPurchase(token, json) {
  accessToken=token;
  let pending=null;
  try {
   const intent=JSON.parse(json)[0];
   if(intent.network!==config.networkId||intent.contract_id!==config.contractId||!/^\d+$/.test(intent.amount_yocto))throw new Error('Checkout configuration mismatch');
   const s=await selector(); const account=s.store.getState().accounts[0]?.accountId;
   if(!account)throw new Error('Connect your NEAR wallet');
   pending={intent,account};sessionStorage.setItem(key,JSON.stringify(pending));
   setPurchaseMessage('APPROVE THE PURCHASE IN YOUR NEAR WALLET',0);
   const wallet=await s.wallet();
   const outcome=await wallet.signAndSendTransaction({signerId:account,receiverId:intent.contract_id,
    actions:[{type:'FunctionCall',params:{methodName:'purchase',args:{intent_id:intent.intent_id,sku_id:intent.sku_id},
     gas:'30000000000000',deposit:intent.amount_yocto}}]});
   if(outcome?.transaction?.hash){pending.hash=outcome.transaction.hash;sessionStorage.setItem(key,JSON.stringify(pending));await verify(pending);}
  }catch(e){busy=false;if(/reject|cancel|denied/i.test(e.message||'')){await cancelReservation(pending);sessionStorage.removeItem(key);}setPurchaseMessage(e.message||'NEAR checkout failed',3);}
 }
 async function resumePurchase(token) {
  accessToken=token;
  try {
   const url=new URL(location.href);
   const pending=JSON.parse(sessionStorage.getItem(key)||'null');
   if(pending){
    const hashes=url.searchParams.get('transactionHashes');
    if(hashes){pending.hash=hashes.split(',')[0];sessionStorage.setItem(key,JSON.stringify(pending));}
    if(url.searchParams.has('errorCode')){await cancelReservation(pending);sessionStorage.removeItem(key);throw new Error('NEAR payment cancelled or rejected');}
    if(pending.hash)await verify(pending);
   }else{
    const sku=sessionStorage.getItem(skuKey);if(sku)await prepare(sku);
   }
   ['transactionHashes','errorCode','errorMessage','account_id','public_key','all_keys'].forEach(k=>url.searchParams.delete(k));
   history.replaceState(null,'',url.href);
  }catch(e){setPurchaseMessage(e.message||'Could not resume payment',3);}finally{busy=false;}
 }
 window.SavannaNear={requestSkuPurchase,startPurchase,setPurchaseMessage,resumePurchase,
  onUnityReady:()=>send('ResumeNearPurchaseFromWeb')};
})();
