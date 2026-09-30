import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const PRODUCTION_ORIGINS = new Set([
  "https://savanna-run.xyz",
  "https://www.savanna-run.xyz",
]);
const DAGBE_SKU = "dagbe_pack";
const COINGECKO_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=nimiq&vs_currencies=usd";

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (PRODUCTION_ORIGINS.has(origin)) return true;

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
  body: unknown,
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

async function getNimUsdPrice(): Promise<number> {
  const response = await fetch(COINGECKO_PRICE_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Savanna-Run-Dagbe-Checkout/1.0",
    },
  });
  if (!response.ok) {
    throw new Error("The live NIM price is temporarily unavailable.");
  }

  const payload = await response.json() as {
    nimiq?: { usd?: number };
  };
  const price = Number(payload?.nimiq?.usd);
  if (!Number.isFinite(price) || price <= 0 || price > 1000) {
    throw new Error("The live NIM price quote is invalid.");
  }
  return price;
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
  const authorization = request.headers.get("Authorization");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(
      { error: "Dagbe checkout is not configured." },
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

  const skuId = typeof body.p_sku_id === "string"
    ? body.p_sku_id.trim().toLowerCase()
    : "";
  const walletAddress = normalizeNimiqAddress(body.p_wallet_address);
  if (skuId !== DAGBE_SKU) {
    return jsonResponse({ error: "This store item is unavailable." }, 400, origin);
  }
  if (!/^NQ[0-9A-Z]{34}$/.test(walletAddress)) {
    return jsonResponse(
      { error: "A valid Nimiq Pay address is required." },
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

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser();
  if (userError || !user) {
    return jsonResponse({ error: "Authentication failed." }, 401, origin);
  }

  const { data: accountMerge, error: accountMergeError } = await serviceClient
    .from("account_merges")
    .select("target_player_id")
    .eq("guest_player_id", user.id)
    .maybeSingle();
  if (accountMergeError) {
    console.error("Dagbe account resolution failed:", accountMergeError);
    return jsonResponse(
      { error: "Runner account could not be resolved." },
      500,
      origin,
    );
  }
  const playerId = accountMerge?.target_player_id || user.id;

  try {
    const { data: sku, error: skuError } = await serviceClient
      .from("nimiq_store_skus")
      .select("usd_price_cents")
      .eq("sku_id", DAGBE_SKU)
      .eq("active", true)
      .single();
    const usdPriceCents = Number(sku?.usd_price_cents);
    if (skuError || !Number.isSafeInteger(usdPriceCents) ||
      usdPriceCents <= 0) {
      throw new Error("The Dagbe Pack price is not configured.");
    }

    const nimUsd = await getNimUsdPrice();
    // 1 NIM = 100,000 Luna. Round up so the server-locked transfer never
    // underpays the configured USD value by a fractional Luna.
    const amountLuna = Math.ceil(
      ((usdPriceCents / 100) / nimUsd) * 100_000,
    );
    if (!Number.isSafeInteger(amountLuna) || amountLuna <= 0) {
      throw new Error("The converted NIM amount is invalid.");
    }

    const { data: intent, error: intentError } = await serviceClient.rpc(
      "create_dynamic_nimiq_purchase_intent",
      {
        p_player_id: playerId,
        p_sku_id: DAGBE_SKU,
        p_wallet_address: walletAddress,
        p_amount_luna: amountLuna,
      },
    );
    if (intentError) {
      console.error("Dagbe purchase intent failed:", intentError);
      return jsonResponse(
        { error: intentError.message || "Could not prepare the purchase." },
        400,
        origin,
      );
    }

    return jsonResponse(intent || [], 200, origin);
  } catch (error) {
    console.error("Dagbe price quote failed:", error);
    return jsonResponse(
      {
        error: error instanceof Error
          ? error.message
          : "Could not prepare the live NIM price.",
      },
      503,
      origin,
    );
  }
});
