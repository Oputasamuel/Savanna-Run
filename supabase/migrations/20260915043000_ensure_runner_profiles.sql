-- Ensure every Supabase Auth identity has a matching Savanna runner profile.
-- This closes the race where a valid session can reach the shop before the
-- username onboarding RPC has created public.players.

begin;

create or replace function public.ensure_runner_profile(
    p_player_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    v_attempt integer := 0;
    v_username text;
begin
    if p_player_id is null or
       p_player_id !~ '^[A-Za-z0-9_-]{16,64}$' then
        raise exception 'A valid player identity is required.';
    end if;

    if exists (
        select 1 from public.players p
        where p.player_id = p_player_id
    ) then
        insert into public.player_stats (player_id)
        values (p_player_id)
        on conflict (player_id) do nothing;
        return;
    end if;

    loop
        -- 16 characters total and safe for the existing username constraint.
        -- A salted retry avoids failing if two generated names ever collide.
        v_username := 'runner_' || substr(
            md5(p_player_id || ':' || v_attempt::text),
            1,
            9
        );

        begin
            insert into public.players (player_id, username)
            values (p_player_id, v_username)
            on conflict (player_id) do nothing;
            exit;
        exception
            when unique_violation then
                v_attempt := v_attempt + 1;
                if v_attempt > 100 then
                    raise exception 'Could not allocate a runner username.';
                end if;
        end;
    end loop;

    insert into public.player_stats (player_id)
    values (p_player_id)
    on conflict (player_id) do nothing;
end;
$function$;

revoke all on function public.ensure_runner_profile(text)
from public, anon, authenticated;
grant execute on function public.ensure_runner_profile(text)
to service_role;

create or replace function public.create_runner_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
begin
    perform public.ensure_runner_profile(new.id::text);
    return new;
end;
$function$;

revoke all on function public.create_runner_profile_for_auth_user()
from public, anon, authenticated;

drop trigger if exists create_runner_profile_after_auth_signup
on auth.users;
create trigger create_runner_profile_after_auth_signup
after insert on auth.users
for each row execute function public.create_runner_profile_for_auth_user();

-- Repair identities created before the trigger existed. This is additive:
-- existing player rows and all balances/inventory are left untouched.
do $function$
declare
    v_user record;
begin
    for v_user in
        select u.id
        from auth.users u
        left join public.players p on p.player_id = u.id::text
        where p.player_id is null
    loop
        perform public.ensure_runner_profile(v_user.id::text);
    end loop;
end;
$function$;

commit;
