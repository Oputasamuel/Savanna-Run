-- One-time Dagbe character pack with two equivalent purchase paths:
-- a server-quoted USD 9.99 NIM payment or 50,000 earned Cowries.

begin;

alter table public.players
    add column if not exists dagbe_unlocked boolean not null default false;

alter table public.nimiq_store_skus
    add column if not exists reward_flying_broom_count integer not null default 0
        check (reward_flying_broom_count >= 0),
    add column if not exists reward_dagbe_unlock boolean not null default false,
    add column if not exists usd_price_cents integer
        check (usd_price_cents is null or usd_price_cents > 0);

alter table public.nimiq_purchase_intents
    add column if not exists reward_flying_broom_count integer not null default 0
        check (reward_flying_broom_count >= 0),
    add column if not exists reward_dagbe_unlock boolean not null default false;

insert into public.nimiq_store_skus (
    sku_id,
    display_name,
    amount_luna,
    treasury_address,
    reward_orb_count,
    reward_magnet_count,
    reward_invincibility_count,
    reward_flying_broom_count,
    reward_dagbe_unlock,
    usd_price_cents,
    active
)
values (
    'dagbe_pack',
    'Dagbe Pack',
    1,
    'NQ401G5MREE70CAADTCMU20479T9RJSXB1V4',
    10,
    15,
    5,
    5,
    true,
    999,
    true
)
on conflict (sku_id) do update set
    display_name = excluded.display_name,
    treasury_address = excluded.treasury_address,
    reward_orb_count = excluded.reward_orb_count,
    reward_magnet_count = excluded.reward_magnet_count,
    reward_invincibility_count = excluded.reward_invincibility_count,
    reward_flying_broom_count = excluded.reward_flying_broom_count,
    reward_dagbe_unlock = excluded.reward_dagbe_unlock,
    usd_price_cents = excluded.usd_price_cents,
    active = excluded.active,
    updated_at = now();

-- Fixed-NIM products continue through the original authenticated RPC. A
-- USD-priced product can only be minted by the service-role function below.
create or replace function public.create_nimiq_purchase_intent(
    p_sku_id text,
    p_wallet_address text
)
returns table (
    intent_id uuid,
    sku_id text,
    display_name text,
    amount_luna bigint,
    treasury_address text,
    payment_reference text,
    expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    v_authenticated_player_id text := (select auth.uid())::text;
    v_player_id text;
    v_wallet_address text := upper(regexp_replace(
        coalesce(p_wallet_address, ''), '\s+', '', 'g'));
    v_sku public.nimiq_store_skus%rowtype;
    v_intent public.nimiq_purchase_intents%rowtype;
    v_intent_id uuid := gen_random_uuid();
begin
    if v_authenticated_player_id is null then
        raise exception 'Authentication is required.';
    end if;

    select coalesce(m.target_player_id, v_authenticated_player_id)
    into v_player_id
    from (select 1) seed
    left join public.account_merges m
      on m.guest_player_id = v_authenticated_player_id;

    if v_wallet_address !~ '^NQ[0-9A-Z]{34}$' then
        raise exception 'A valid Nimiq Pay address is required.';
    end if;
    if not exists (
        select 1 from public.players p where p.player_id = v_player_id
    ) then
        raise exception 'Create a runner profile first.';
    end if;

    select * into v_sku
    from public.nimiq_store_skus s
    where s.sku_id = lower(trim(coalesce(p_sku_id, '')))
      and s.active;
    if not found then
        raise exception 'This store item is unavailable.';
    end if;
    if v_sku.usd_price_cents is not null then
        raise exception 'This item requires a live NIM price quote.';
    end if;

    update public.nimiq_purchase_intents i
    set status = 'expired'
    where i.player_id = v_player_id
      and i.status = 'pending'
      and i.expires_at <= now();

    insert into public.nimiq_purchase_intents (
        intent_id, player_id, sku_id, wallet_address, amount_luna,
        treasury_address, payment_reference, reward_orb_count,
        reward_magnet_count, reward_invincibility_count,
        reward_flying_broom_count, reward_dagbe_unlock
    ) values (
        v_intent_id, v_player_id, v_sku.sku_id, v_wallet_address,
        v_sku.amount_luna, v_sku.treasury_address,
        'SR:' || v_intent_id::text, v_sku.reward_orb_count,
        v_sku.reward_magnet_count, v_sku.reward_invincibility_count,
        v_sku.reward_flying_broom_count, v_sku.reward_dagbe_unlock
    ) returning * into v_intent;

    return query select
        v_intent.intent_id,
        v_sku.sku_id,
        v_sku.display_name,
        v_intent.amount_luna,
        v_intent.treasury_address,
        v_intent.payment_reference,
        v_intent.expires_at;
end;
$function$;

create or replace function public.create_dynamic_nimiq_purchase_intent(
    p_player_id text,
    p_sku_id text,
    p_wallet_address text,
    p_amount_luna bigint
)
returns table (
    intent_id uuid,
    sku_id text,
    display_name text,
    amount_luna bigint,
    treasury_address text,
    payment_reference text,
    expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    v_player_id text := trim(coalesce(p_player_id, ''));
    v_wallet_address text := upper(regexp_replace(
        coalesce(p_wallet_address, ''), '\s+', '', 'g'));
    v_sku public.nimiq_store_skus%rowtype;
    v_intent public.nimiq_purchase_intents%rowtype;
    v_intent_id uuid := gen_random_uuid();
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Service role authorization is required.';
    end if;
    if v_wallet_address !~ '^NQ[0-9A-Z]{34}$' then
        raise exception 'A valid Nimiq Pay address is required.';
    end if;
    if p_amount_luna is null or p_amount_luna <= 0 then
        raise exception 'A valid quoted NIM amount is required.';
    end if;

    select * into v_sku
    from public.nimiq_store_skus s
    where s.sku_id = lower(trim(coalesce(p_sku_id, '')))
      and s.active
      and s.usd_price_cents is not null;
    if not found then
        raise exception 'This dynamically priced item is unavailable.';
    end if;
    if not exists (
        select 1 from public.players p where p.player_id = v_player_id
    ) then
        raise exception 'Create a runner profile first.';
    end if;
    if v_sku.reward_dagbe_unlock and exists (
        select 1 from public.players p
        where p.player_id = v_player_id and p.dagbe_unlocked
    ) then
        raise exception 'Dagbe Pack is already owned.';
    end if;

    update public.nimiq_purchase_intents i
    set status = 'expired'
    where i.player_id = v_player_id
      and i.status = 'pending'
      and i.expires_at <= now();

    insert into public.nimiq_purchase_intents (
        intent_id, player_id, sku_id, wallet_address, amount_luna,
        treasury_address, payment_reference, reward_orb_count,
        reward_magnet_count, reward_invincibility_count,
        reward_flying_broom_count, reward_dagbe_unlock
    ) values (
        v_intent_id, v_player_id, v_sku.sku_id, v_wallet_address,
        p_amount_luna, v_sku.treasury_address,
        'SR:' || v_intent_id::text, v_sku.reward_orb_count,
        v_sku.reward_magnet_count, v_sku.reward_invincibility_count,
        v_sku.reward_flying_broom_count, v_sku.reward_dagbe_unlock
    ) returning * into v_intent;

    return query select
        v_intent.intent_id,
        v_sku.sku_id,
        v_sku.display_name,
        v_intent.amount_luna,
        v_intent.treasury_address,
        v_intent.payment_reference,
        v_intent.expires_at;
end;
$function$;

revoke all on function public.create_dynamic_nimiq_purchase_intent(
    text, text, text, bigint
) from public, anon, authenticated;
grant execute on function public.create_dynamic_nimiq_purchase_intent(
    text, text, text, bigint
) to service_role;

drop function if exists public.confirm_nimiq_purchase(
    uuid, text, text, text, bigint, bigint, jsonb
);

create function public.confirm_nimiq_purchase(
    p_intent_id uuid,
    p_tx_hash text,
    p_wallet_address text,
    p_treasury_address text,
    p_amount_luna bigint,
    p_block_number bigint,
    p_verification_data jsonb default '{}'::jsonb
)
returns table (
    orb_count integer,
    magnet_count integer,
    invincibility_count integer,
    flying_broom_count integer,
    dagbe_unlocked boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    v_intent public.nimiq_purchase_intents%rowtype;
    v_sku public.nimiq_store_skus%rowtype;
    v_actual_sender text := upper(regexp_replace(
        coalesce(p_wallet_address, ''), '\s+', '', 'g'));
begin
    if coalesce(auth.role(), '') <> 'service_role' then
        raise exception 'Service role authorization is required.';
    end if;
    if v_actual_sender !~ '^NQ[0-9A-Z]{34}$' then
        raise exception 'Verified Nimiq sender is invalid.';
    end if;

    select * into v_intent
    from public.nimiq_purchase_intents i
    where i.intent_id = p_intent_id
    for update;
    if not found then raise exception 'Purchase intent was not found.'; end if;

    if v_intent.status = 'confirmed' then
        if v_intent.tx_hash <> lower(regexp_replace(p_tx_hash, '^0x', '')) then
            raise exception 'Purchase intent was already completed.';
        end if;
        return query select
            p.orb_count, p.magnet_count, p.invincibility_count,
            p.flying_broom_count, p.dagbe_unlocked
        from public.players p where p.player_id = v_intent.player_id;
        return;
    end if;
    if v_intent.status not in ('pending', 'expired') then
        raise exception 'Purchase intent is no longer recoverable.';
    end if;

    select * into v_sku
    from public.nimiq_store_skus s
    where s.sku_id = v_intent.sku_id
      and s.active
      and s.treasury_address = v_intent.treasury_address
      and (s.usd_price_cents is not null or
           s.amount_luna = v_intent.amount_luna)
      and s.reward_orb_count = v_intent.reward_orb_count
      and s.reward_magnet_count = v_intent.reward_magnet_count
      and s.reward_invincibility_count = v_intent.reward_invincibility_count
      and s.reward_flying_broom_count =
          v_intent.reward_flying_broom_count
      and s.reward_dagbe_unlock = v_intent.reward_dagbe_unlock;
    if not found then
        raise exception 'Expired purchase terms no longer match the active SKU.';
    end if;

    if upper(regexp_replace(p_treasury_address, '\s+', '', 'g')) <>
            v_intent.treasury_address or
       p_amount_luna <> v_intent.amount_luna then
        raise exception 'Verified transfer does not match the purchase intent.';
    end if;

    insert into public.nimiq_onchain_payments (
        tx_hash, intent_id, player_id, wallet_address, treasury_address,
        amount_luna, block_number, verification_data
    ) values (
        lower(regexp_replace(p_tx_hash, '^0x', '')), v_intent.intent_id,
        v_intent.player_id, v_actual_sender,
        v_intent.treasury_address, v_intent.amount_luna, p_block_number,
        coalesce(p_verification_data, '{}'::jsonb)
    );

    update public.players p set
        orb_count = p.orb_count + v_intent.reward_orb_count,
        magnet_count = p.magnet_count + v_intent.reward_magnet_count,
        invincibility_count =
            p.invincibility_count + v_intent.reward_invincibility_count,
        flying_broom_count =
            p.flying_broom_count + v_intent.reward_flying_broom_count,
        dagbe_unlocked =
            p.dagbe_unlocked or v_intent.reward_dagbe_unlock,
        updated_at = now()
    where p.player_id = v_intent.player_id;

    update public.nimiq_purchase_intents i set
        wallet_address = v_actual_sender,
        status = 'confirmed',
        tx_hash = lower(regexp_replace(p_tx_hash, '^0x', '')),
        confirmed_at = now()
    where i.intent_id = v_intent.intent_id;

    return query select
        p.orb_count, p.magnet_count, p.invincibility_count,
        p.flying_broom_count, p.dagbe_unlocked
    from public.players p where p.player_id = v_intent.player_id;
end;
$function$;

revoke all on function public.confirm_nimiq_purchase(
    uuid, text, text, text, bigint, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.confirm_nimiq_purchase(
    uuid, text, text, text, bigint, bigint, jsonb
) to service_role;

create or replace function public.purchase_dagbe_pack_with_cowries()
returns table (
    total_cowries bigint,
    orb_count integer,
    magnet_count integer,
    invincibility_count integer,
    flying_broom_count integer,
    dagbe_unlocked boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    v_authenticated_player_id text := (select auth.uid())::text;
    v_player_id text;
begin
    if v_authenticated_player_id is null then
        raise exception 'Authentication is required.';
    end if;

    select coalesce(m.target_player_id, v_authenticated_player_id)
    into v_player_id
    from (select 1) seed
    left join public.account_merges m
      on m.guest_player_id = v_authenticated_player_id;

    return query
    update public.players p
    set total_cowries = p.total_cowries - 50000,
        orb_count = p.orb_count + 10,
        magnet_count = p.magnet_count + 15,
        invincibility_count = p.invincibility_count + 5,
        flying_broom_count = p.flying_broom_count + 5,
        dagbe_unlocked = true,
        updated_at = now()
    where p.player_id = v_player_id
      and p.total_cowries >= 50000
      and not p.dagbe_unlocked
    returning
        p.total_cowries,
        p.orb_count,
        p.magnet_count,
        p.invincibility_count,
        p.flying_broom_count,
        p.dagbe_unlocked;

    if not found then
        if exists (
            select 1 from public.players p
            where p.player_id = v_player_id and p.dagbe_unlocked
        ) then
            raise exception 'Dagbe Pack is already owned.';
        end if;
        if not exists (
            select 1 from public.players p where p.player_id = v_player_id
        ) then
            raise exception 'Create a runner profile first.';
        end if;
        raise exception 'You need 50,000 Cowries for the Dagbe Pack.';
    end if;

    insert into public.economy_ledger (
        player_id, cowrie_change, balance_after, reason, reference_id
    )
    select
        v_player_id, -50000, p.total_cowries,
        'dagbe_pack_purchase', 'dagbe_pack'
    from public.players p
    where p.player_id = v_player_id;
end;
$function$;

revoke all on function public.purchase_dagbe_pack_with_cowries()
from public, anon;
grant execute on function public.purchase_dagbe_pack_with_cowries()
to authenticated;

commit;
