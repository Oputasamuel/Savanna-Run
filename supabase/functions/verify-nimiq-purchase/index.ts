import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const PRODUCTION_ORIGINS = new Set([
  "https://savanna-run.xyz",
  "https://www.savanna-run.xyz",
]);

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (PRODUCTION_ORIGINS.has(origin)) return true;

  // Nimiq Pay's official local-testing flow loads a LAN HTTP URL in its
  // WebView. Permit only loopback and RFC1918 IPv4 origins for that workflow.
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (/^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.(?:\d{1,3})\.(?:\d{1,3})$/.test(host)) return true;
    const match = /^172\.(\d{1,3})\.(?:\d{1,3})\.(?:\d{1,3})$/.exec(host);
    return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
  } catch {
    return false;
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && isAllowedOrigin(origin)
    ? origin
    : "https://savanna-run.xyz";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  origin: string | null,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function normalizeNimiqAddress(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, "").toUpperCase()
    : "";
}

function normalizeHash(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/^0x/, "")
    : "";
}

function decodeData(value: unknown): string {
  if (Array.isArray(value) && value.every((item) =>
    Number.isInteger(item) && item >= 0 && item <= 255
  )) {
    try {
      return new TextDecoder().decode(new Uint8Array(value)).replace(/\0+$/, "");
    } catch {
      return "";
    }
  }
  if (value && typeof value === "object" && "data" in value) {
    return decodeData((value as Record<string, unknown>).data);
  }
  if (typeof value !== "string") return "";
  if (value.startsWith("SR:")) return value;
  const hex = value.replace(/^0x/, "");
  if (hex && hex.length % 2 === 0 && /^[0-9a-f]+$/i.test(hex)) {
    try {
      const bytes = new Uint8Array(
        hex.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)),
      );
      return new TextDecoder().decode(bytes).replace(/\0+$/, "");
    } catch {
      return "";
    }
  }
  try {
    const normalizedBase64 = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - value.length % 4) % 4);
    const bytes = Uint8Array.from(atob(normalizedBase64), (character) =>
      character.charCodeAt(0)
    );
    return new TextDecoder().decode(bytes).replace(/\0+$/, "");
  } catch {
    return "";
  }
}

function containsPaymentReference(
  value: unknown,
  expected: string,
  depth = 0,
): boolean {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === "string" || Array.isArray(value)) {
    if (decodeData(value) === expected) return true;
    if (Array.isArray(value) && !value.every((item) => typeof item === "number")) {
      return value.some((item) =>
        containsPaymentReference(item, expected, depth + 1)
      );
    }
    return false;
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((item) =>
      containsPaymentReference(item, expected, depth + 1)
    );
  }
  return false;
}

async function rpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`Nimiq RPC returned HTTP ${response.status}.`);
  }
  const payload = await response.json();
  if (payload.error) {
    const detail = String(
      payload.error.data || payload.error.message || "",
    ).toLowerCase();
    if (detail.includes("transaction not found")) return null;
    throw new Error(payload.error.message || "Nimiq RPC request failed.");
  }
  const result = payload.result;
  if (result && typeof result === "object" && "data" in result) {
    return result.data;
  }
  return result;
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405, origin);
  }
  if (!isAllowedOrigin(origin)) {
    return jsonResponse({ error: "Origin is not allowed." }, 403, origin);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const rpcUrl = Deno.env.get("NIMIQ_RPC_URL");
  const expectedNetwork = Deno.env.get("NIMIQ_NETWORK");
  const authorization = request.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !rpcUrl ||
      !expectedNetwork ||
      !["main-albatross", "test-albatross"].includes(
        expectedNetwork.toLowerCase(),
      )) {
    return jsonResponse(
      { error: "Nimiq payment verification is not configured." },
      503,
      origin,
    );
  }
  if (!authorization?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authentication is required." }, 401, origin);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON request." }, 400, origin);
  }
  const intentId = typeof body.intentId === "string" ? body.intentId : "";
  const txHash = normalizeHash(body.txHash);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(intentId) || !/^[0-9a-f]{64}$/.test(txHash)) {
    return jsonResponse(
      { error: "A valid intent and Nimiq transaction hash are required." },
      400,
      origin,
    );
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) {
    return jsonResponse({ error: "Authentication failed." }, 401, origin);
  }

  const { data: accountMerge, error: accountMergeError } = await serviceClient
    .from("account_merges")
    .select("target_player_id")
    .eq("guest_player_id", user.id)
    .maybeSingle();
  if (accountMergeError) {
    console.error("Nimiq account resolution failed:", accountMergeError);
    return jsonResponse({ error: "Runner account could not be resolved." }, 500, origin);
  }
  const resolvedPlayerId = accountMerge?.target_player_id || user.id;

  const { data: intent, error: intentError } = await serviceClient
    .from("nimiq_purchase_intents")
    .select(
      "intent_id,player_id,wallet_address,amount_luna,treasury_address,payment_reference,status,tx_hash,expires_at",
    )
    .eq("intent_id", intentId)
    .maybeSingle();
  if (intentError || !intent || intent.player_id !== resolvedPlayerId) {
    return jsonResponse({ error: "Purchase request was not found." }, 404, origin);
  }

  if (intent.status === "confirmed" && intent.tx_hash === txHash) {
    const { data: inventory } = await serviceClient
      .from("players")
      .select(
        "orb_count,magnet_count,invincibility_count," +
          "flying_broom_count,dagbe_unlocked",
      )
      .eq("player_id", resolvedPlayerId)
      .single();
    return jsonResponse(
      { ok: true, alreadyConfirmed: true, inventory },
      200,
      origin,
    );
  }
  if (intent.status !== "pending" && intent.status !== "expired") {
    return jsonResponse({ error: "Purchase is no longer pending." }, 409, origin);
  }

  try {
    const result = await rpc(rpcUrl, "getTransactionByHash", [txHash]);
    if (!result) {
      return jsonResponse(
        { ok: false, pending: true, message: "Payment is still confirming." },
        202,
        origin,
      );
    }
    const tx = result as Record<string, unknown>;
    const sender = normalizeNimiqAddress(
      tx.sender ?? tx.from ?? tx.senderAddress ?? tx.sender_address,
    );
    const recipient = normalizeNimiqAddress(
      tx.recipient ?? tx.to ?? tx.recipientAddress ?? tx.recipient_address,
    );
    const transactionHash = normalizeHash(tx.transactionHash ?? tx.hash);
    const amount = Number(tx.value ?? tx.amount);
    const blockNumber = Number(
      tx.blockHeight ?? tx.blockNumber ?? tx.block_number,
    );
    const networkValue = tx.network ?? tx.networkId ?? tx.network_id ?? "";
    const network = String(networkValue);
    const reference = decodeData(
      tx.data ?? tx.recipientData ?? tx.recipient_data ?? tx.extraData,
    );
    const referenceMatches = reference === intent.payment_reference ||
      containsPaymentReference(tx, intent.payment_reference);
    const transactionState = String(
      tx.state ?? tx.transactionState ?? "",
    ).toLowerCase();

    if (transactionHash && transactionHash !== txHash) {
      throw new Error("Nimiq RPC returned a different transaction.");
    }
    if (tx.valid === false || tx.executionResult === false) {
      throw new Error("Nimiq transaction was not successful.");
    }
    if (!Number.isSafeInteger(blockNumber) || blockNumber <= 0 ||
        transactionState === "new" ||
        transactionState === "pending" ||
        transactionState === "mempool") {
      return jsonResponse(
        { ok: false, pending: true, message: "Payment is still confirming." },
        202,
        origin,
      );
    }
    const expectedNetworkId = expectedNetwork.toLowerCase() === "test-albatross"
      ? 5
      : 24;
    const networkMatches = typeof networkValue === "number"
      ? networkValue === expectedNetworkId
      : !network || network.toLowerCase().includes(
        expectedNetwork.toLowerCase().replace("-albatross", ""),
      );
    if (!networkMatches) {
      throw new Error("Nimiq transaction is on the wrong network.");
    }
    if (recipient !== intent.treasury_address ||
        amount !== Number(intent.amount_luna) ||
        !referenceMatches) {
      console.error("Nimiq intent mismatch", {
        senderMatches: sender === intent.wallet_address,
        recipientMatches: recipient === intent.treasury_address,
        amountMatches: amount === Number(intent.amount_luna),
        referenceMatches,
        transactionState,
        blockNumber,
      });
      if (recipient !== intent.treasury_address) {
        throw new Error("Nimiq payment recipient does not match its purchase intent.");
      }
      if (amount !== Number(intent.amount_luna)) {
        throw new Error("Nimiq payment amount does not match its purchase intent.");
      }
      throw new Error("Nimiq payment reference does not match its purchase intent.");
    }

    const { data: inventory, error: confirmError } = await serviceClient.rpc(
      "confirm_nimiq_purchase",
      {
        p_intent_id: intent.intent_id,
        p_tx_hash: txHash,
        p_wallet_address: sender,
        p_treasury_address: recipient,
        p_amount_luna: amount,
        p_block_number: blockNumber,
        p_verification_data: {
          network,
          confirmations: tx.confirmations ?? null,
          state: tx.state ?? null,
          paymentReference: intent.payment_reference,
        },
      },
    );
    if (confirmError) {
      console.error("Nimiq purchase confirmation failed:", confirmError);
      return jsonResponse(
        { error: "Payment verified but inventory could not be updated." },
        500,
        origin,
      );
    }
    return jsonResponse(
      { ok: true, txHash, inventory: inventory?.[0] || null },
      200,
      origin,
    );
  } catch (error) {
    console.error("Nimiq verification failed:", error);
    return jsonResponse(
      { error: error instanceof Error ? error.message : "Verification failed." },
      400,
      origin,
    );
  }
});
