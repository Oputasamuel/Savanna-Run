-- Keep Nimiq purchases attached to the permanent runner when an old guest
-- session is still active briefly after account merging.

begin;

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

    update public.nimiq_purchase_intents i
    set status = 'expired'
    where i.player_id = v_player_id
      and i.status = 'pending'
      and i.expires_at <= now();

    insert into public.nimiq_purchase_intents (
        intent_id, player_id, sku_id, wallet_address, amount_luna,
        treasury_address, payment_reference, reward_orb_count,
        reward_magnet_count, reward_invincibility_count
    ) values (
        v_intent_id, v_player_id, v_sku.sku_id, v_wallet_address,
        v_sku.amount_luna, v_sku.treasury_address,
        'SR:' || v_intent_id::text, v_sku.reward_orb_count,
        v_sku.reward_magnet_count, v_sku.reward_invincibility_count
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

revoke all on function public.create_nimiq_purchase_intent(text, text)
from public, anon;
grant execute on function public.create_nimiq_purchase_intent(text, text)
to authenticated;

-- Merged guest identities must never receive a second independent profile.
-- The purchase RPC above resolves them to their permanent target instead.
create or replace function public.create_runner_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
    if not exists (
        select 1 from public.account_merges m
        where m.guest_player_id = new.id::text
    ) then
        perform public.ensure_runner_profile(new.id::text);
    end if;
    return new;
end;
$function$;

commit;
