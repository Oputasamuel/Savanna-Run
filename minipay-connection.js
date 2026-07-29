(function () {
  "use strict";

  var CELO_MAINNET_CHAIN_ID = 42220;
  var CELO_SEPOLIA_CHAIN_ID = 11142220;
  var statusElement = document.getElementById("minipay-status");

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

  function updateNetwork(chainId) {
    state.chainId = chainId;

    if (chainId === CELO_SEPOLIA_CHAIN_ID) {
      state.network = "celo-sepolia";
      setStatus(
        "MINIPAY TEST READY \u2022 " + shortAddress(state.address),
        "ready"
      );
      return;
    }

    if (chainId === CELO_MAINNET_CHAIN_ID) {
      state.network = "celo-mainnet";
      setStatus(
        "MINIPAY MAINNET \u2022 ENABLE USE TESTNET FOR THIS TEST",
        "warning"
      );
      return;
    }

    state.network = "unsupported";
    setStatus(
      "OPEN DEVELOPER SETTINGS AND ENABLE USE TESTNET",
      "warning"
    );
  }

  function announceReady() {
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

  async function connect() {
    var provider = window.ethereum;
    state.isMiniPay = Boolean(provider && provider.isMiniPay === true);

    if (!state.isMiniPay) {
      if (statusElement) statusElement.hidden = true;
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

  window.SavannaMiniPay = {
    state: state,
    ready: connect()
  };
})();
