(function () {
  "use strict";

  var SDK_URL =
    "https://cdn.jsdelivr.net/npm/@nimiq/mini-app-sdk@0.0.2/+esm";
  var SUPABASE_URL = "https://zchyyafleejtwcjhezqu.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_oMtFmvtIdW4CCPeeoPHLtQ_3VzIruE-";
  var VERIFIER_URL =
    SUPABASE_URL + "/functions/v1/verify-nimiq-purchase";
  var PURCHASE_INTENT_URL =
    SUPABASE_URL + "/rest/v1/rpc/create_nimiq_purchase_intent";
  var SKU_AMOUNTS_LUNA = {
    orb_1: 100000000
  };
  var SKU_TREASURIES = {
    orb_1: "NQ401G5MREE70CAADTCMU20479T9RJSXB1V4"
  };
  var PENDING_PAYMENT_KEY = "savanna.nimiq.mainnet.pendingPayment";

  var purchaseInProgress = false;
  var transactionCooldownUntil = 0;
  var pendingSkuId = null;
  var provider = null;
  var providerPromise = null;
  var state = {
    isNimiqPay: false,
    providerReady: false,
    connected: false,
    address: null,
    consensus: false,
    error: null
  };

  // Unity calls setSelectionRange on its hidden mobile-keyboard input.
  // Safari rejects that operation for type=email and turns it into a large
  // Unity error dialog. Ignore only that specific WebKit limitation.
  (function installMobileEmailSelectionGuard() {
    if (!window.HTMLInputElement) return;
    var nativeSetSelectionRange =
      window.HTMLInputElement.prototype.setSelectionRange;
    if (!nativeSetSelectionRange || nativeSetSelectionRange.__savannaGuarded) {
      return;
    }
    function guardedSetSelectionRange(start, end, direction) {
      try {
        return nativeSetSelectionRange.call(this, start, end, direction);
      } catch (error) {
        if (error && error.name === "InvalidStateError" &&
            String(this.type || "").toLowerCase() === "email") {
          return;
        }
        throw error;
      }
    }
    guardedSetSelectionRange.__savannaGuarded = true;
    window.HTMLInputElement.prototype.setSelectionRange =
      guardedSetSelectionRange;
  })();

  function normalizeAddress(value) {
    return String(value || "").replace(/\s+/g, "").toUpperCase();
  }

  function friendlyError(error) {
    var message = error && error.message
      ? error.message
      : String(error || "Payment failed.");
    var lower = message.toLowerCase();
    if (lower.indexOf("reject") >= 0 ||
        lower.indexOf("denied") >= 0 ||
        lower.indexOf("cancel") >= 0) {
      return "PAYMENT CANCELLED";
    }
    if (lower.indexOf("balance") >= 0 ||
        lower.indexOf("fund") >= 0) {
      return "NIM BALANCE IS TOO LOW";
    }
    if (lower.indexOf("already in progress") >= 0) {
      return "A NIMIQ TRANSACTION IS STILL OPEN \u2022 WAIT, THEN RETRY";
    }
    if (lower.indexOf("sender") >= 0 && lower.indexOf("recipient") >= 0) {
      return "PAYMENT WALLET AND TREASURY WALLET MUST BE DIFFERENT";
    }
    return message.length > 100
      ? "THE PAYMENT COULD NOT BE COMPLETED"
      : message.toUpperCase();
  }

  // Nimiq Pay provider calls can either throw or resolve to an ErrorResponse.
  // Treat both forms identically so a rejected account/payment request never
  // gets mistaken for a valid truthy result.
  function providerError(value) {
    if (!value || typeof value !== "object" || !("error" in value)) {
      return null;
    }
    var error = value.error;
    if (error && typeof error.message === "string") return error.message;
    return "Nimiq Pay provider request failed.";
  }

  function requireProviderResult(value) {
    var message = providerError(value);
    if (message) throw new Error(message);
    return value;
  }

  function notifyUnity(message, kind) {
    if (!window.SavannaUnityInstance) return;
    window.SavannaUnityInstance.SendMessage(
      "Savanna Supabase Client",
      "SetNimiqPurchaseMessageFromWeb",
      String(kind || 0) + "|" + String(message || "")
    );
  }

  function setPurchaseMessage(message, kind) {
    notifyUnity(message, kind);
    if (kind === 3) purchaseInProgress = false;
  }

  async function verifyPurchase(accessToken, intentId, txHash) {
    for (var attempt = 0; attempt < 120; attempt += 1) {
      var response = await fetch(VERIFIER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_PUBLISHABLE_KEY,
          "Authorization": "Bearer " + accessToken
        },
        body: JSON.stringify({ intentId: intentId, txHash: txHash })
      });
      var body = {};
      try { body = await response.json(); } catch (_) { body = {}; }
      if (response.ok && response.status !== 202 && body.ok) return body;
      if (response.status !== 202) {
        throw new Error(body.error || "The payment could not be verified.");
      }
      setPurchaseMessage("PAYMENT SENT \u2022 WAITING FOR CONFIRMATION\u2026", 0);
      await new Promise(function (resolve) { setTimeout(resolve, 2000); });
    }
    throw new Error("Payment is still confirming. Reopen the game shortly.");
  }

  async function fetchPurchaseIntent(accessToken, skuId, walletAddress) {
    var response = await fetch(PURCHASE_INTENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_PUBLISHABLE_KEY,
        "Authorization": "Bearer " + accessToken
      },
      body: JSON.stringify({
        p_sku_id: skuId,
        p_wallet_address: walletAddress
      })
    });
    var body = null;
    try { body = await response.json(); } catch (_) { body = null; }
    if (!response.ok) {
      throw new Error(
        body && (body.message || body.error)
          ? body.message || body.error
          : "Could not refresh the purchase intent."
      );
    }
    var intent = Array.isArray(body) ? body[0] : body;
    if (!intent || typeof intent !== "object") {
      throw new Error("The refreshed purchase intent is missing.");
    }
    return intent;
  }

  async function resumePendingPayment(accessToken) {
    var saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(PENDING_PAYMENT_KEY) || "null");
    } catch (_) {
      saved = null;
    }
    if (!saved ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(saved.intentId || "")) ||
        !/^(?:0x)?[0-9a-f]{64}$/i.test(String(saved.txHash || "")) ||
        !Number.isFinite(Number(saved.createdAt)) ||
        Date.now() - Number(saved.createdAt) > 86400000) {
      try { localStorage.removeItem(PENDING_PAYMENT_KEY); } catch (_) {}
      return false;
    }

    setPurchaseMessage("RECOVERING PREVIOUS NIMIQ PAYMENT\u2026", 0);
    var verification = await verifyPurchase(
      accessToken,
      String(saved.intentId),
      String(saved.txHash)
    );
    setPurchaseMessage("PAYMENT COMPLETE \u2022 +1 ORB", 1);
    try { localStorage.removeItem(PENDING_PAYMENT_KEY); } catch (_) {}
    window.SavannaUnityInstance.SendMessage(
      "Savanna Supabase Client",
      "OnNimiqPurchaseResult",
      JSON.stringify(verification)
    );
    return true;
  }

  async function startPurchase(accessToken, intentJson) {
    purchaseInProgress = true;
    try {
      if (!provider || !state.connected || !state.consensus) {
        throw new Error("Nimiq Pay is not ready.");
      }
      if (!accessToken) throw new Error("The secure player session is missing.");
      if (await resumePendingPayment(accessToken)) return;

      var parsedIntent = JSON.parse(intentJson);
      var intent = Array.isArray(parsedIntent)
        ? parsedIntent[0]
        : parsedIntent;
      if (!intent || typeof intent !== "object") {
        throw new Error("The purchase intent is missing.");
      }
      var intentId = String(intent.intent_id || "").trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)) {
        setPurchaseMessage("REFRESHING SECURE PURCHASE INTENT\u2026", 0);
        intent = await fetchPurchaseIntent(
          accessToken,
          pendingSkuId,
          state.address
        );
        intentId = String(intent.intent_id || "").trim();
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentId)) {
        throw new Error("The purchase intent ID is invalid.");
      }
      var value = Number(intent.amount_luna);
      // PostgREST exposes PostgreSQL bigint values, which older Unity WebGL
      // JSON serialization can lose while round-tripping through C#. The SKU
      // price is fixed here only as a transport fallback; the server verifier
      // still requires the exact amount stored in the signed-in user's intent.
      if ((!Number.isSafeInteger(value) || value <= 0) &&
          pendingSkuId && SKU_AMOUNTS_LUNA[pendingSkuId]) {
        value = SKU_AMOUNTS_LUNA[pendingSkuId];
      }
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error("The NIM amount is invalid.");
      }
      var recipient = normalizeAddress(intent.treasury_address);
      if (!/^NQ[0-9A-Z]{34}$/.test(recipient) &&
          pendingSkuId && SKU_TREASURIES[pendingSkuId]) {
        recipient = SKU_TREASURIES[pendingSkuId];
      }
      if (!/^NQ[0-9A-Z]{34}$/.test(recipient)) {
        throw new Error("The treasury wallet address is invalid.");
      }
      if (recipient === normalizeAddress(state.address)) {
        throw new Error(
          "Payment wallet and treasury wallet must be different."
        );
      }
      var paymentReference = String(
        intent.payment_reference || ("SR:" + intentId)
      );
      if (paymentReference !== "SR:" + intentId ||
          paymentReference.length > 64) {
        throw new Error("The payment reference is invalid.");
      }

      setPurchaseMessage(
        "MAINNET \u2022 CONFIRM " +
          (value / 100000).toFixed(5).replace(/0+$/, "") +
          " REAL NIM IN NIMIQ PAY",
        0
      );
      var txHash = requireProviderResult(
        await provider.sendBasicTransactionWithData({
          recipient: recipient,
          value: value,
          data: paymentReference
        })
      );
      if (typeof txHash !== "string" ||
          !/^(?:0x)?[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error("Nimiq Pay returned an invalid transaction hash.");
      }

      try {
        localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({
          intentId: intentId,
          txHash: txHash,
          createdAt: Date.now()
        }));
      } catch (_) {}

      setPurchaseMessage("PAYMENT SENT \u2022 VERIFYING\u2026", 0);
      var verification = await verifyPurchase(
        accessToken,
        intentId,
        txHash
      );
      setPurchaseMessage("PAYMENT COMPLETE \u2022 +1 ORB", 1);
      try { localStorage.removeItem(PENDING_PAYMENT_KEY); } catch (_) {}
      window.SavannaUnityInstance.SendMessage(
        "Savanna Supabase Client",
        "OnNimiqPurchaseResult",
        JSON.stringify(verification)
      );
    } catch (error) {
      transactionCooldownUntil = Date.now() + 10000;
      setPurchaseMessage(friendlyError(error), 3);
    } finally {
      pendingSkuId = null;
      purchaseInProgress = false;
    }
  }

  async function initializeProvider() {
    if (provider) return provider;
    if (providerPromise) return providerPromise;

    providerPromise = (async function () {
      var sdk = await import(SDK_URL);
      provider = await sdk.init({ timeout: 20000 });
      state.isNimiqPay = true;
      state.providerReady = true;
      state.error = null;
      document.documentElement.dataset.nimiqPay = "true";
      return provider;
    })();

    try {
      return await providerPromise;
    } catch (error) {
      providerPromise = null;
      provider = null;
      state.providerReady = false;
      state.isNimiqPay = false;
      throw error;
    }
  }

  async function connectWalletForPurchase(skuId) {
    try {
      setPurchaseMessage("CONNECTING TO NIMIQ PAY\u2026", 0);
      var activeProvider = await initializeProvider();

      // listAccounts is Nimiq Pay's wallet permission request. Calling it
      // from the Buy tap keeps the native approval tied to a user gesture.
      if (!state.connected || !state.address) {
        var accounts = requireProviderResult(
          await activeProvider.listAccounts()
        );
        state.address = accounts && accounts.length
          ? normalizeAddress(accounts[0])
          : null;
        state.connected = Boolean(state.address);
        if (!state.connected) throw new Error("Nimiq Pay returned no account.");
      }

      setPurchaseMessage("CHECKING NIMIQ MAINNET\u2026", 0);
      state.consensus = Boolean(requireProviderResult(
        await activeProvider.isConsensusEstablished()
      ));
      if (!state.consensus) throw new Error("Nimiq network is still syncing.");
      if (!window.SavannaUnityInstance) {
        throw new Error("The game is still loading. Please try again.");
      }

      setPurchaseMessage("PREPARING SECURE ORB PURCHASE\u2026", 0);
      window.SavannaUnityInstance.SendMessage(
        "Savanna Supabase Client",
        "BeginNimiqSkuPurchaseFromWeb",
        skuId + "|" + state.address
      );
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      var lower = state.error.toLowerCase();
      var unavailable = !window.nimiqPay && (
        lower.indexOf("timeout") >= 0 ||
        lower.indexOf("provider") >= 0 ||
        lower.indexOf("mini app") >= 0
      );
      console.error("Savanna Nimiq purchase connection failed:", error);
      setPurchaseMessage(
        unavailable
          ? "OPEN SAVANNA RUN INSIDE NIMIQ PAY"
          : (window.nimiqPay
              ? "NIMIQ PAY CONNECTION FAILED \u2022 TAP BUY TO RETRY"
              : friendlyError(error)),
        unavailable ? 2 : 3
      );
      pendingSkuId = null;
      purchaseInProgress = false;
    }
  }

  function requestSkuPurchase(skuId) {
    var normalizedSku = String(skuId || "").trim();
    if (normalizedSku !== "orb_1") {
      setPurchaseMessage("THIS NIMIQ ITEM IS UNAVAILABLE", 3);
      return false;
    }
    if (Date.now() < transactionCooldownUntil) {
      setPurchaseMessage(
        "WAIT FOR NIMIQ PAY TO CLOSE THE PREVIOUS TRANSACTION",
        2
      );
      return false;
    }
    if (!window.SavannaUnityInstance || purchaseInProgress) {
      setPurchaseMessage("NIMIQ PURCHASE IS NOT READY YET", 2);
      return false;
    }

    purchaseInProgress = true;
    pendingSkuId = normalizedSku;
    void connectWalletForPurchase(normalizedSku);
    // Re-apply after Unity's synchronous button handler returns; older local
    // builds otherwise briefly overwrite this with the confirmation message.
    setTimeout(function () {
      if (purchaseInProgress && !state.connected) {
        setPurchaseMessage("CONNECTING TO NIMIQ PAY\u2026", 0);
      }
    }, 0);
    return true;
  }

  async function detectNimiqPay() {
    try {
      await initializeProvider();
      setPurchaseMessage(
        "NIMIQ MAINNET \u2022 TAP BUY TO CONNECT",
        0
      );
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
      // A Buy tap retries provider initialization after the game has loaded.
    }
    return state;
  }

  window.SavannaNimiq = {
    state: state,
    ready: detectNimiqPay(),
    setPurchaseMessage: setPurchaseMessage,
    startPurchase: startPurchase,
    requestSkuPurchase: requestSkuPurchase,
    onUnityReady: function () {
      if (state.providerReady) {
        setPurchaseMessage(
          "NIMIQ MAINNET \u2022 TAP BUY TO CONNECT",
          0
        );
      }
    }
  };
})();
