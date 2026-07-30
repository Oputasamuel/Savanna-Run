(function () {
  "use strict";

  var CELO_MAINNET_CHAIN_ID = 42220;
  var CELO_SEPOLIA_CHAIN_ID = 11142220;
  var CELO_SEPOLIA_USDM =
    "0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b";
  var SUPABASE_URL =
    "https://zchyyafleejtwcjhezqu.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY =
    "sb_publishable_oMtFmvtIdW4CCPeeoPHLtQ_3VzIruE-";
  var VERIFIER_URL =
    SUPABASE_URL + "/functions/v1/verify-minipay-purchase";
  var TRANSFER_SELECTOR = "a9059cbb";
  var CELO_ATTRIBUTION_SUFFIX =
    "63656c6f5f353237396638356161653764" +
    "110080218021802180218021802180218021";

  var statusElement = document.getElementById("minipay-status");
  var purchaseButton = document.getElementById(
    "minipay-test-purchase"
  );
  var purchaseInProgress = false;

  var state = {
    isMiniPay: false,
    connected: false,
    address: null,
    chainId: null,
    network: null,
    error: null
  };

  function parseChainId(value) {
    if (typeof value === "number") return value;
    if (typeof value !== "string") return null;

    var parsed = value.toLowerCase().indexOf("0x") === 0
      ? parseInt(value, 16)
      : parseInt(value, 10);

    return Number.isFinite(parsed) ? parsed : null;
  }

  function shortAddress(address) {
    if (!address || address.length < 10) return "";
    return address.slice(0, 6) + "\u2026" + address.slice(-4);
  }

  function setStatus(message, kind) {
    if (!statusElement) return;

    statusElement.textContent = message;
    statusElement.dataset.kind = kind || "pending";
    statusElement.hidden = false;
  }

  function kindFromUnity(kind) {
    if (kind === 1) return "ready";
    if (kind === 2) return "warning";
    if (kind === 3) return "error";
    return "pending";
  }

  function setPurchaseMessage(message, kind) {
    setStatus(
      String(message || "MINIPAY PURCHASE UPDATE"),
      kindFromUnity(kind)
    );
    if (kind === 2 || kind === 3) {
      purchaseInProgress = false;
      updatePurchaseButton();
    }
  }

  function canPurchase() {
    return state.isMiniPay &&
      state.connected &&
      state.chainId === CELO_SEPOLIA_CHAIN_ID &&
      Boolean(window.SavannaUnityInstance) &&
      !purchaseInProgress;
  }

  function updatePurchaseButton() {
    if (!purchaseButton) return;

    var visible = state.isMiniPay &&
      state.connected &&
      state.chainId === CELO_SEPOLIA_CHAIN_ID;
    purchaseButton.hidden = !visible;
    purchaseButton.disabled = !canPurchase();
  }

  function updateNetwork(chainId) {
    state.chainId = chainId;

    if (chainId === CELO_SEPOLIA_CHAIN_ID) {
      state.network = "celo-sepolia";
      setStatus(
        "MINIPAY TEST READY \u2022 " + shortAddress(state.address),
        "ready"
      );
      updatePurchaseButton();
      return;
    }

    if (chainId === CELO_MAINNET_CHAIN_ID) {
      state.network = "celo-mainnet";
      setStatus(
        "MINIPAY MAINNET \u2022 ENABLE USE TESTNET FOR THIS TEST",
        "warning"
      );
      updatePurchaseButton();
      return;
    }

    state.network = "unsupported";
    setStatus(
      "OPEN DEVELOPER SETTINGS AND ENABLE USE TESTNET",
      "warning"
    );
    updatePurchaseButton();
  }

  function announceReady() {
    updatePurchaseButton();
    window.dispatchEvent(new CustomEvent("savanna:minipay-ready", {
      detail: {
        isMiniPay: state.isMiniPay,
        connected: state.connected,
        address: state.address,
        chainId: state.chainId,
        network: state.network,
        error: state.error
      }
    }));
  }

  function padWord(value) {
    return value.padStart(64, "0");
  }

  function parseAtomicAmount(value) {
    if (typeof value === "bigint") {
      if (value < 0n) {
        throw new Error("The payment amount is invalid.");
      }
      return value;
    }

    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error("The payment amount is invalid.");
      }
      return BigInt(value);
    }

    var normalized = String(value == null ? "" : value).trim();
    var wholeAtomicMatch = normalized.match(/^(\d+)(?:\.0+)?$/);
    if (wholeAtomicMatch) {
      return BigInt(wholeAtomicMatch[1]);
    }

    var scientificMatch = normalized.match(
      /^(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/
    );
    if (scientificMatch) {
      var fraction = scientificMatch[2] || "";
      var digits = scientificMatch[1] + fraction;
      var scale = Number(scientificMatch[3]) - fraction.length;
      if (Number.isSafeInteger(scale)) {
        if (scale >= 0) {
          return BigInt(digits + "0".repeat(scale));
        }

        var fractionalAtomicDigits = digits.slice(scale);
        if (/^0+$/.test(fractionalAtomicDigits)) {
          return BigInt(digits.slice(0, scale) || "0");
        }
      }
    }

    throw new Error("The payment amount is invalid.");
  }

  function formatTokenAmount(amountAtomic, decimals) {
    var amount = parseAtomicAmount(amountAtomic);
    var places = Number(decimals);
    if (!Number.isInteger(places) || places < 0 || places > 36) {
      throw new Error("The payment token decimals are invalid.");
    }

    var divisor = 10n ** BigInt(places);
    var whole = amount / divisor;
    var fraction = (amount % divisor).toString().padStart(places, "0");
    fraction = fraction.replace(/0+$/, "");
    return fraction
      ? whole.toString() + "." + fraction
      : whole.toString();
  }

  function encodeTransfer(recipient, amountAtomic) {
    var normalizedRecipient = String(recipient || "")
      .toLowerCase()
      .replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(normalizedRecipient)) {
      throw new Error("The payment recipient is invalid.");
    }

    var amount = parseAtomicAmount(amountAtomic);
    if (amount <= 0n) {
      throw new Error("The payment amount is invalid.");
    }

    return "0x" +
      TRANSFER_SELECTOR +
      padWord(normalizedRecipient) +
      padWord(amount.toString(16)) +
      CELO_ATTRIBUTION_SUFFIX;
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

    if (lower.indexOf("insufficient") >= 0 ||
        lower.indexOf("balance") >= 0 ||
        lower.indexOf("fund") >= 0) {
      return "USDC OR USDM BALANCE IS TOO LOW";
    }

    if (lower.indexOf("profile") >= 0) {
      return "CHOOSE A RUNNER NAME BEFORE BUYING";
    }

    return message.length > 100
      ? "THE TEST PAYMENT COULD NOT BE COMPLETED"
      : message.toUpperCase();
  }

  async function recoverPurchaseIntent(accessToken, intent) {
    var originalAmountIsValid = false;
    try {
      originalAmountIsValid =
        parseAtomicAmount(intent.amount_atomic) > 0n;
    } catch (error) {
      originalAmountIsValid = false;
    }

    if (originalAmountIsValid) {
      return intent;
    }

    var response = await fetch(
      SUPABASE_URL + "/rest/v1/rpc/create_purchase_intent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_PUBLISHABLE_KEY,
          "Authorization": "Bearer " + accessToken
        },
        body: JSON.stringify({
          p_sku_id: String(intent.sku_id || ""),
          p_wallet_address: String(state.address || "")
        })
      }
    );

    var rows = [];
    try {
      rows = await response.json();
    } catch (parseError) {
      rows = [];
    }

    if (!response.ok) {
      throw new Error(
        "Server intent request failed (HTTP " + response.status + ")."
      );
    }

    var recovered = Array.isArray(rows)
      ? rows[0]
      : (rows && rows.amount_atomic != null ? rows : null);
    if (!recovered) {
      throw new Error("Server intent returned no payment row.");
    }
    if (recovered.sku_id !== intent.sku_id) {
      throw new Error("Server intent SKU did not match.");
    }

    var recoveredAmount;
    try {
      recoveredAmount = parseAtomicAmount(recovered.amount_atomic);
    } catch (amountError) {
      throw new Error(
        "Server intent amount format was " +
        typeof recovered.amount_atomic + "."
      );
    }
    if (recoveredAmount <= 0n) {
      throw new Error("Server intent amount was zero.");
    }

    return recovered;
  }

  async function verifyPurchase(accessToken, intentId, txHash) {
    for (var attempt = 0; attempt < 25; attempt += 1) {
      var response = await fetch(VERIFIER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": SUPABASE_PUBLISHABLE_KEY,
          "Authorization": "Bearer " + accessToken
        },
        body: JSON.stringify({
          intentId: intentId,
          txHash: txHash
        })
      });

      var body = {};
      try {
        body = await response.json();
      } catch (parseError) {
        body = {};
      }

      if (response.ok && response.status !== 202 && body.ok) {
        return body;
      }

      if (response.status !== 202) {
        throw new Error(
          body.error || "The payment could not be verified."
        );
      }

      setStatus("PAYMENT SENT \u2022 WAITING FOR CONFIRMATION\u2026", "pending");
      await new Promise(function (resolve) {
        setTimeout(resolve, 1500);
      });
    }

    throw new Error(
      "Payment is still confirming. Reopen the game shortly."
    );
  }

  async function startPurchase(accessToken, intentJson) {
    purchaseInProgress = true;
    updatePurchaseButton();

    try {
      if (!state.isMiniPay ||
          !state.connected ||
          state.chainId !== CELO_SEPOLIA_CHAIN_ID ||
          !window.SavannaUnityInstance) {
        throw new Error("MiniPay test mode is not ready.");
      }

      var provider = window.ethereum;
      var intent = JSON.parse(intentJson);
      if (!provider || provider.isMiniPay !== true) {
        throw new Error("Open Savanna Run inside MiniPay.");
      }
      // The active MiniPay provider is the authoritative client-side
      // network signal. The verifier independently loads the intent from
      // Supabase and enforces its stored chain before awarding inventory.
      // Do not reject on Unity's serialized bigint copy of chain_id.
      if (state.chainId !== CELO_SEPOLIA_CHAIN_ID) {
        throw new Error("Enable Use Testnet in MiniPay first.");
      }
      if (!accessToken) {
        throw new Error("The secure player session is missing.");
      }

      intent = await recoverPurchaseIntent(accessToken, intent);
      var displayAmount = formatTokenAmount(
        intent.amount_atomic,
        intent.token_decimals
      );
      setStatus(
        "CONFIRM " + displayAmount + " " +
          intent.token_symbol +
          " IN MINIPAY \u2022 NETWORK FEE IN USDM",
        "pending"
      );

      var txHash = await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from: state.address,
          to: intent.token_address,
          value: "0x0",
          data: encodeTransfer(
            intent.treasury_address,
            intent.amount_atomic
          ),
          feeCurrency: CELO_SEPOLIA_USDM
        }]
      });

      if (typeof txHash !== "string" ||
          !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        throw new Error("MiniPay returned an invalid transaction.");
      }

      setStatus("PAYMENT SENT \u2022 VERIFYING\u2026", "pending");
      var verification = await verifyPurchase(
        accessToken,
        intent.intent_id,
        txHash
      );

      var rewardMessage = intent.sku_id === "orb_1"
        ? "+1 ORB"
        : "+1 MAGNET";
      setStatus(
        "PAYMENT COMPLETE \u2022 " + rewardMessage,
        "ready"
      );
      if (window.SavannaUnityInstance) {
        window.SavannaUnityInstance.SendMessage(
          "Savanna Supabase Client",
          "OnMiniPayPurchaseResult",
          JSON.stringify(verification)
        );
      }
    } catch (error) {
      setStatus(friendlyError(error), "error");
    } finally {
      purchaseInProgress = false;
      updatePurchaseButton();
    }
  }

  function requestSkuPurchase(skuId) {
    var normalizedSku = String(skuId || "").trim();
    if (normalizedSku !== "orb_1") {
      setStatus("THIS MINIPAY ITEM IS UNAVAILABLE", "error");
      return false;
    }

    if (!state.isMiniPay || !state.connected) {
      setStatus("OPEN SAVANNA RUN INSIDE MINIPAY", "warning");
      return false;
    }
    if (state.chainId !== CELO_SEPOLIA_CHAIN_ID) {
      setStatus(
        "ENABLE USE TESTNET IN MINIPAY FOR THIS TEST",
        "warning"
      );
      return false;
    }
    if (!window.SavannaUnityInstance || purchaseInProgress) {
      setStatus("MINIPAY PURCHASE IS NOT READY YET", "warning");
      return false;
    }

    purchaseInProgress = true;
    updatePurchaseButton();
    setStatus("PREPARING SECURE ORB PURCHASE\u2026", "pending");
    try {
      window.SavannaUnityInstance.SendMessage(
        "Savanna Supabase Client",
        "BeginMiniPaySkuPurchaseFromWeb",
        normalizedSku + "|" + state.address
      );
      return true;
    } catch (error) {
      purchaseInProgress = false;
      updatePurchaseButton();
      setStatus("UNITY IS NOT READY YET", "warning");
      return false;
    }
  }

  async function connect() {
    var provider = window.ethereum;
    state.isMiniPay = Boolean(provider && provider.isMiniPay === true);

    if (!state.isMiniPay) {
      if (statusElement) statusElement.hidden = true;
      if (purchaseButton) purchaseButton.hidden = true;
      announceReady();
      return state;
    }

    document.documentElement.dataset.minipay = "true";
    setStatus("CONNECTING TO MINIPAY\u2026", "pending");

    try {
      var results = await Promise.all([
        provider.request({ method: "eth_requestAccounts" }),
        provider.request({ method: "eth_chainId" })
      ]);

      var accounts = results[0] || [];
      state.address = accounts.length > 0 ? accounts[0] : null;
      state.connected = Boolean(state.address);

      if (!state.connected) {
        throw new Error("MiniPay returned no wallet account.");
      }

      updateNetwork(parseChainId(results[1]));

      if (typeof provider.on === "function") {
        provider.on("accountsChanged", function (accountsChanged) {
          state.address = accountsChanged && accountsChanged.length
            ? accountsChanged[0]
            : null;
          state.connected = Boolean(state.address);

          if (state.connected) updateNetwork(state.chainId);
          else setStatus("MINIPAY CONNECTION LOST", "error");

          announceReady();
        });

        provider.on("chainChanged", function (chainChanged) {
          updateNetwork(parseChainId(chainChanged));
          announceReady();
        });
      }

      announceReady();
      return state;
    } catch (error) {
      state.connected = false;
      state.error = error && error.message
        ? error.message
        : "MiniPay connection failed.";

      setStatus("MINIPAY CONNECTION FAILED \u2022 REOPEN THE APP", "error");
      announceReady();
      return state;
    }
  }

  if (purchaseButton) {
    purchaseButton.addEventListener("click", function () {
      if (!canPurchase()) return;

      purchaseInProgress = true;
      updatePurchaseButton();
      setStatus("PREPARING SECURE TEST PURCHASE\u2026", "pending");
      try {
        window.SavannaUnityInstance.SendMessage(
          "Savanna Supabase Client",
          "BeginMiniPayTestPurchaseFromWeb",
          state.address
        );
      } catch (error) {
        purchaseInProgress = false;
        updatePurchaseButton();
        setStatus("UNITY IS NOT READY YET", "warning");
      }
    });
  }

  window.SavannaMiniPay = {
    state: state,
    ready: connect(),
    setPurchaseMessage: setPurchaseMessage,
    startPurchase: startPurchase,
    requestSkuPurchase: requestSkuPurchase,
    onUnityReady: updatePurchaseButton,
    encodeTransfer: encodeTransfer
  };
})();
