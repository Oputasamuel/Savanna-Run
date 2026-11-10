(function () {
 'use strict';
 const config = window.SavannaNearConfig || {};
 const key = 'savanna.near.pending.v1';
 const skuKey = 'savanna.near.sku.v1';
 let selectorPromise, busy = false, accessToken = '';
 let walletPopup = null, walletPopupTimer = 0;
 const send = (method, value) => window.SavannaUnityInstance?.SendMessage('Savanna Supabase Client', method, value || '');
 function setPurchaseMessage(message, kind) { send('SetNearPurchaseMessageFromWeb', `${kind}|${message}`); }
 function popupFeatures() {
  const width=420,height=700,left=Math.max(0,((window.innerWidth||screen.width)-width)/2),top=Math.max(0,((window.innerHeight||screen.height)-height)/2);
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
 }
 function renderPopupWait(message) {
  if(!walletPopup||walletPopup.closed)return;
  try {
   walletPopup.document.open();
   walletPopup.document.write(`<!doctype html><title>Savanna Run NEAR Checkout</title><meta name="viewport" content="width=device-width"><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#120904;color:#ffe0a0;font:700 16px Arial;text-align:center}div{padding:32px}small{display:block;margin-top:12px;color:#d8ae6d;font-size:12px}</style><div>${message}<small>Keep this window open while the secure purchase is prepared.</small></div>`);
   walletPopup.document.close();
  } catch(_) { /* The wallet page is cross-origin while it is active. */ }
 }
 function armPopupTimeout() {
  clearTimeout(walletPopupTimer);
  walletPopupTimer=setTimeout(()=>closeWalletPopup(),90000);
 }
 function closeWalletPopup() {
  clearTimeout(walletPopupTimer);walletPopupTimer=0;
  try { if(walletPopup&&!walletPopup.closed)walletPopup.close(); } catch(_) {}
  walletPopup=null;
 }
 function openWalletPopup() {
  closeWalletPopup();
  walletPopup=window.open('about:blank','MyNearWallet',popupFeatures());
  if(!walletPopup)throw new Error('Your browser blocked the NEAR wallet. Tap Buy again or allow popups for this site.');
  renderPopupWait('PREPARING NEAR CHECKOUT...');
  armPopupTimeout();
 }
 async function withWalletPopup(action,keepOpenAfterSuccess) {
  if(!walletPopup||walletPopup.closed)throw new Error('NEAR wallet window closed. Tap Buy again to continue.');
  clearTimeout(walletPopupTimer);walletPopupTimer=0;
  const nativeOpen=window.open;
  let proxyClosed=false;
  const popupProxy={
   get closed(){return proxyClosed||!walletPopup||walletPopup.closed;},
   focus(){try{walletPopup?.focus();}catch(_){}},
   close(){
    if(keepOpenAfterSuccess&&walletPopup&&!walletPopup.closed){
     proxyClosed=true;
     try{walletPopup.location.replace('about:blank');}catch(_){}
     setTimeout(()=>renderPopupWait('WALLET CONNECTED. PREPARING PURCHASE...'),0);
     armPopupTimeout();
    }else closeWalletPopup();
   }
  };
  const interceptedOpen=function(url,name,features){
   if(name==='MyNearWallet'&&walletPopup&&!walletPopup.closed){
    try{walletPopup.location.href=url;}catch(_){}
    try{walletPopup.focus();}catch(_){}
    return keepOpenAfterSuccess?popupProxy:walletPopup;
   }
   return nativeOpen.call(window,url,name,features);
  };
  window.open=interceptedOpen;
  try{
   const result=await action();
   // MyNearWallet removes its message listener when the returned popup reports
   // closed. Give its 300 ms cleanup poll one turn before reusing the real window.
   if(keepOpenAfterSuccess)await new Promise(resolve=>setTimeout(resolve,350));
   return result;
  }
  finally{if(window.open===interceptedOpen)window.open=nativeOpen;}
 }
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
   await withWalletPopup(()=>wallet.signIn({contractId:config.contractId,methodNames:[]}),true);
   accounts = s.store.getState().accounts;
   if (!accounts.length) return; // Redirect wallet resumes on page return.
  }
  sessionStorage.removeItem(skuKey);
  send('BeginNearSkuPurchaseFromWeb', `${sku}|${accounts[0].accountId}`);
 }
 function requestSkuPurchase(sku) {
  if (busy || !['orb_1','dagbe_pack','kesi_upgrade_01','dagbe_upgrade_01'].includes(sku)) return false;
  const pending = JSON.parse(sessionStorage.getItem(key)||'null');
  if(pending){
   if(pending.hash){send('ResumeNearPurchaseFromWeb');return true;}
   setTimeout(()=>setPurchaseMessage('A payment is awaiting its wallet result. Return from your wallet before starting another payment.',3),0);
   return true;
  }
  try{openWalletPopup();}
  catch(e){setTimeout(()=>setPurchaseMessage(e.message||'Could not open the NEAR wallet',3),0);return true;}
  busy = true;
  (async()=>{
   try {
    await prepare(sku);
   } catch(e) { busy=false; closeWalletPopup(); setPurchaseMessage(e.message || 'NEAR wallet connection failed',3); }
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
   const outcome=await withWalletPopup(()=>wallet.signAndSendTransaction({signerId:account,receiverId:intent.contract_id,
    actions:[{type:'FunctionCall',params:{methodName:'purchase',args:{intent_id:intent.intent_id,sku_id:intent.sku_id},
     gas:'30000000000000',deposit:intent.amount_yocto}}]}),false);
   if(outcome?.transaction?.hash){pending.hash=outcome.transaction.hash;sessionStorage.setItem(key,JSON.stringify(pending));await verify(pending);}
  }catch(e){busy=false;closeWalletPopup();if(/reject|cancel|denied|closed|popup/i.test(e.message||'')){await cancelReservation(pending);sessionStorage.removeItem(key);}setPurchaseMessage(e.message||'NEAR checkout failed',3);}
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
