(function () {
 'use strict';
 const config=window.SavannaNearConfig||{};
 const pendingKey='savanna.near.pending.v2';
 const allowedSkus=new Set(['orb_1','dagbe_pack','kesi_upgrade_01','dagbe_upgrade_01']);
 let busy=false,identity={token:'',userId:'',email:'',verified:false};
 let nearModule=null,nearConnection=null,unlocked=null;
 const send=(method,value)=>window.SavannaUnityInstance?.SendMessage('Savanna Supabase Client',method,value||'');
 const enc=new TextEncoder(),dec=new TextDecoder();
 const b64=bytes=>btoa(String.fromCharCode(...bytes));
 const unb64=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));
 const setPurchaseMessage=(message,kind)=>send('SetNearPurchaseMessageFromWeb',`${kind}|${message}`);
 const storageKey=()=>`savanna.near.embedded.v1.${identity.userId}`;
 const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

 async function nearApi(){
  nearModule ||= await import('https://esm.sh/near-api-js@5.1.1');
  return nearModule;
 }
 async function connection(){
  if(nearConnection)return nearConnection;
  const api=await nearApi();
  nearConnection=await api.connect({networkId:'testnet',nodeUrl:config.rpcUrl||'https://rpc.testnet.near.org',keyStore:new api.keyStores.InMemoryKeyStore()});
  return nearConnection;
 }
 function publicKeyBytes(keyPair){return new Uint8Array(keyPair.getPublicKey().data);}
 function implicitAddress(keyPair){return Array.from(publicKeyBytes(keyPair),b=>b.toString(16).padStart(2,'0')).join('');}
 function randomBytes(size){return crypto.getRandomValues(new Uint8Array(size));}
 async function encryptionKey(recoveryCode,salt){
  const material=await crypto.subtle.importKey('raw',enc.encode(recoveryCode),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:310000},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 }
 async function storeEncrypted(keyPair,recoveryCode){
  const salt=randomBytes(16),iv=randomBytes(12),key=await encryptionKey(recoveryCode,salt);
  const secret=keyPair.toString();
  const cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(identity.userId)},key,enc.encode(secret)));
  const record={version:1,userId:identity.userId,network:'testnet',accountId:implicitAddress(keyPair),publicKey:keyPair.getPublicKey().toString(),salt:b64(salt),iv:b64(iv),cipher:b64(cipher)};
  localStorage.setItem(storageKey(),JSON.stringify(record));
  return record;
 }
 async function unlockStored(recoveryCode){
  const raw=localStorage.getItem(storageKey());if(!raw)throw new Error('No wallet is stored for this account. Import the recovery code instead.');
  const record=JSON.parse(raw);if(record.userId!==identity.userId||record.network!=='testnet')throw new Error('This wallet belongs to a different Savanna account.');
  const key=await encryptionKey(recoveryCode,unb64(record.salt));
  let secret;
  try{secret=dec.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(record.iv),additionalData:enc.encode(identity.userId)},key,unb64(record.cipher)));}
  catch(_){throw new Error('Incorrect recovery code.');}
  const api=await nearApi(),pair=api.KeyPair.fromString(secret);
  if(implicitAddress(pair)!==record.accountId)throw new Error('Wallet integrity check failed.');
  await setUnlocked(pair,record);
 }
 async function setUnlocked(pair,record){
  const near=await connection();
  await near.config.keyStore.setKey('testnet',record.accountId,pair);
  unlocked={pair,record,account:await near.account(record.accountId)};
  sessionStorage.setItem('savanna.near.unlocked.account',record.accountId);
  await refreshWalletUi();
 }
 async function walletFunction(action,payload={}){
  const response=await fetch(`${config.supabaseUrl}/functions/v1/embedded-near-wallet`,{method:'POST',headers:{'Content-Type':'application/json',apikey:config.publishableKey,Authorization:`Bearer ${identity.token}`},body:JSON.stringify({action,...payload})});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Wallet service unavailable');return data;
 }
 async function register(pair){
  const accountId=implicitAddress(pair),publicKey=pair.getPublicKey().toString();
  const challenge=await walletFunction('challenge',{account_id:accountId,public_key:publicKey});
  const signed=pair.sign(enc.encode(challenge.message));
  await walletFunction('register',{challenge_id:challenge.challenge_id,account_id:accountId,public_key:publicKey,signature:b64(new Uint8Array(signed.signature))});
 }
 async function createWallet(){
  requireVerified();const api=await nearApi(),pair=api.KeyPair.fromRandom('ed25519');
  const recovery=pair.toString();
  showRecovery(recovery,async()=>{await register(pair);const record=await storeEncrypted(pair,recovery);await setUnlocked(pair,record);setWalletNotice('Wallet created. Fund this TESTNET address before buying.','ok');});
 }
 async function importWallet(recovery){
  requireVerified();const api=await nearApi();let pair;
  try{pair=api.KeyPair.fromString(recovery.trim());}catch(_){throw new Error('That recovery code is not valid.');}
  await register(pair);const record=await storeEncrypted(pair,recovery.trim());await setUnlocked(pair,record);setWalletNotice('Wallet recovered on this device.','ok');
 }
 function requireVerified(){if(!identity.token||!identity.userId||!identity.verified)throw new Error('Verify your email in Savanna Run before creating a wallet.');}
 async function balance(accountId){
  try{const near=await connection();const view=await near.connection.provider.query({request_type:'view_account',finality:'final',account_id:accountId});return (Number(view.amount)/1e24).toFixed(4);}
  catch(_){return '0.0000';}
 }

 function ensureUi(){
  if(document.getElementById('savanna-near-button'))return;
  const style=document.createElement('style');style.textContent=`
  #savanna-near-button{position:fixed;right:12px;bottom:72px;z-index:2147483000;border:1px solid #e4b54b;border-radius:22px;padding:9px 13px;background:#17100a;color:#ffd46d;font:700 12px Arial;box-shadow:0 4px 18px #0008}
  #savanna-near-modal{position:fixed;inset:0;z-index:2147483001;background:#050301d9;display:none;align-items:center;justify-content:center;font-family:Arial;color:#fff;padding:16px}#savanna-near-modal.open{display:flex}
  #savanna-near-card{width:min(430px,94vw);background:linear-gradient(#25160b,#0e0906);border:1px solid #d79c38;border-radius:18px;padding:20px;box-shadow:0 18px 70px #000}#savanna-near-card h2{margin:0 0 5px;color:#ffd36a}
  #savanna-near-card .badge{display:inline-block;background:#0f5585;color:#dff5ff;border-radius:20px;padding:4px 9px;font-size:11px;font-weight:bold}#savanna-near-card .address{word-break:break-all;background:#090604;border-radius:9px;padding:10px;font:12px monospace;color:#d7cbb8;margin:10px 0}
  #savanna-near-card input{box-sizing:border-box;width:100%;padding:11px;border-radius:8px;border:1px solid #7b5b31;background:#0b0806;color:#fff;margin:8px 0}#savanna-near-card button{padding:10px 12px;border:0;border-radius:8px;background:#cf8d28;color:#160d05;font-weight:800;margin:4px}#savanna-near-card button.alt{background:#403328;color:#fff}
  #savanna-near-notice{min-height:18px;color:#f6c96b;font-size:12px;margin-top:8px}.wallet-row{display:flex;flex-wrap:wrap;margin-top:10px}.wallet-balance{font-size:28px;font-weight:900;margin:10px 0}.wallet-help{font-size:12px;color:#c7b69c;line-height:1.45}`;
  document.head.appendChild(style);
  const button=document.createElement('button');button.id='savanna-near-button';button.textContent='NEAR TESTNET';button.onclick=()=>openWallet();document.body.appendChild(button);
  const modal=document.createElement('div');modal.id='savanna-near-modal';modal.innerHTML=`<div id="savanna-near-card"><div style="float:right"><button class="alt" id="savanna-near-close">✕</button></div><span class="badge">TESTNET ONLY</span><h2>Embedded NEAR Wallet</h2><div id="savanna-near-body"></div><div id="savanna-near-notice"></div></div>`;document.body.appendChild(modal);
  modal.querySelector('#savanna-near-close').onclick=()=>modal.classList.remove('open');modal.onclick=e=>{if(e.target===modal)modal.classList.remove('open');};
 }
 function setWalletNotice(message,kind=''){ensureUi();const el=document.getElementById('savanna-near-notice');el.textContent=message;el.style.color=kind==='error'?'#ff7878':kind==='ok'?'#7ee7a4':'#f6c96b';}
 async function openWallet(){ensureUi();document.getElementById('savanna-near-modal').classList.add('open');await refreshWalletUi();}
 async function refreshWalletUi(){
  ensureUi();const body=document.getElementById('savanna-near-body');
  if(!identity.verified){body.innerHTML='<p>Link and verify an email account in Savanna Run to create your wallet.</p><p class="wallet-help">Wallet keys are never derived from your email.</p>';return;}
  const stored=localStorage.getItem(storageKey());
  if(unlocked){const amount=await balance(unlocked.record.accountId);body.innerHTML=`<div class="wallet-balance">${amount} NEAR</div><div class="address">${unlocked.record.accountId}</div><div class="wallet-row"><button id="near-copy">COPY ADDRESS</button><button id="near-fund">ADD TEST FUNDS</button><button class="alt" id="near-lock">LOCK</button></div><p class="wallet-help">Only testnet tokens are supported. They have no monetary value.</p>`;
   body.querySelector('#near-copy').onclick=async()=>{await navigator.clipboard.writeText(unlocked.record.accountId);setWalletNotice('Testnet address copied.','ok');};
   body.querySelector('#near-fund').onclick=async()=>{await navigator.clipboard.writeText(unlocked.record.accountId);window.open(config.testnetFaucetUrl||'https://near-faucet.io/','_blank','noopener');setWalletNotice('Address copied. Paste it into the testnet faucet.');};
   body.querySelector('#near-lock').onclick=()=>{unlocked=null;sessionStorage.removeItem('savanna.near.unlocked.account');refreshWalletUi();};return;
  }
  body.innerHTML=`<p>${stored?'Unlock the wallet stored for this verified account.':'Create a random embedded wallet or recover an existing one.'}</p><input id="near-recovery" type="password" autocomplete="off" placeholder="Recovery code (ed25519:...)"><div class="wallet-row">${stored?'<button id="near-unlock">UNLOCK</button>':'<button id="near-create">CREATE WALLET</button>'}<button class="alt" id="near-import">RECOVER WALLET</button></div><p class="wallet-help">The recovery code is never uploaded. Losing it means the wallet cannot be recovered.</p>`;
  const input=body.querySelector('#near-recovery');
  body.querySelector('#near-create')?.addEventListener('click',()=>createWallet().catch(e=>setWalletNotice(e.message,'error')));
  body.querySelector('#near-unlock')?.addEventListener('click',()=>unlockStored(input.value.trim()).catch(e=>setWalletNotice(e.message,'error')));
  body.querySelector('#near-import').onclick=()=>importWallet(input.value).catch(e=>setWalletNotice(e.message,'error'));
 }
 function showRecovery(code,onConfirmed){
  const body=document.getElementById('savanna-near-body');body.innerHTML=`<p><b>Save this recovery code now.</b> Anyone with it controls the testnet wallet.</p><div class="address" id="near-new-code">${code}</div><button id="near-copy-code">COPY</button><input id="near-confirm-code" autocomplete="off" placeholder="Paste the recovery code to confirm"><button id="near-confirm-create">I SAVED IT</button>`;
  body.querySelector('#near-copy-code').onclick=async()=>{await navigator.clipboard.writeText(code);setWalletNotice('Recovery code copied. Store it safely.');};
  body.querySelector('#near-confirm-create').onclick=async()=>{if(body.querySelector('#near-confirm-code').value.trim()!==code)return setWalletNotice('Paste the exact recovery code to continue.','error');try{await onConfirmed();}catch(e){setWalletNotice(e.message,'error');}};
 }
 async function prepare(sku){requireVerified();if(!unlocked){await openWallet();throw new Error('Unlock your embedded testnet wallet, then tap Buy again.');}send('BeginNearSkuPurchaseFromWeb',`${sku}|${unlocked.record.accountId}`);}
 function requestSkuPurchase(sku){if(busy||!allowedSkus.has(sku))return false;const pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');if(pending?.hash){send('ResumeNearPurchaseFromWeb');return true;}busy=true;prepare(sku).catch(e=>{busy=false;setPurchaseMessage(e.message||'Embedded wallet unavailable',3);});return true;}
 async function verify(pending){
  for(let attempt=0;attempt<12;attempt++){const response=await fetch(`${config.supabaseUrl}/functions/v1/verify-near-purchase`,{method:'POST',headers:{'Content-Type':'application/json',apikey:config.publishableKey,Authorization:`Bearer ${identity.token}`},body:JSON.stringify({intent_id:pending.intent.intent_id,tx_hash:pending.hash})});const result=await response.json();if(response.ok&&result.ok){sessionStorage.removeItem(pendingKey);send('OnNearPurchaseResult',JSON.stringify(result));setPurchaseMessage('PURCHASE CONFIRMED',1);busy=false;refreshWalletUi();return;}if([401,403,404].includes(response.status))throw new Error(result.error||'Payment could not be verified');await sleep(1500);}throw new Error('Payment verification is pending. The transaction reference is saved; retry to check it again.');
 }
 async function cancelReservation(pending){if(!pending?.intent?.intent_id||!identity.token)return;try{await fetch(`${config.supabaseUrl}/rest/v1/rpc/cancel_near_purchase`,{method:'POST',headers:{'Content-Type':'application/json',apikey:config.publishableKey,Authorization:`Bearer ${identity.token}`},body:JSON.stringify({p_intent_id:pending.intent.intent_id})});}catch(_){} }
 async function startPurchase(token,json){
  identity.token=token;let pending=null;
  try{if(!unlocked)throw new Error('Unlock your embedded testnet wallet.');const intent=JSON.parse(json)[0];if(intent.network!=='testnet'||intent.contract_id!==config.contractId||!/^[0-9]+$/.test(intent.amount_yocto))throw new Error('Checkout configuration mismatch');pending={intent,account:unlocked.record.accountId};sessionStorage.setItem(pendingKey,JSON.stringify(pending));setPurchaseMessage('SIGNING WITH YOUR EMBEDDED TESTNET WALLET',0);const outcome=await unlocked.account.functionCall({contractId:intent.contract_id,methodName:'purchase',args:{intent_id:intent.intent_id,sku_id:intent.sku_id},gas:30000000000000n,attachedDeposit:BigInt(intent.amount_yocto)});if(!outcome?.transaction?.hash)throw new Error('NEAR did not return a transaction hash');pending.hash=outcome.transaction.hash;sessionStorage.setItem(pendingKey,JSON.stringify(pending));await verify(pending);
  }catch(e){busy=false;if(!pending?.hash){await cancelReservation(pending);sessionStorage.removeItem(pendingKey);}setPurchaseMessage(e.message||'NEAR checkout failed',3);}
 }
 async function resumePurchase(token){identity.token=token;try{const pending=JSON.parse(sessionStorage.getItem(pendingKey)||'null');if(pending?.hash)await verify(pending);}catch(e){setPurchaseMessage(e.message||'Could not resume payment',3);}finally{busy=false;}}
 function setSession(token,userId,email,isVerified){identity={token,userId,email,verified:isVerified==='1'||isVerified===1||isVerified===true};unlocked=null;nearConnection=null;ensureUi();refreshWalletUi();}
 window.SavannaNear={requestSkuPurchase,startPurchase,setPurchaseMessage,resumePurchase,setSession,openWallet,onUnityReady:()=>{ensureUi();send('ResumeNearPurchaseFromWeb');}};
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ensureUi);else ensureUi();
})();
