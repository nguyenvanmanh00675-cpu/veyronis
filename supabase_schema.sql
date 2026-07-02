-- =====================================================================
-- VEYRONIS - SCHEMA SUPABASE
-- Chạy toàn bộ file này trong Supabase Dashboard > SQL Editor > New query
-- =====================================================================

-- ---------- 1. BẢNG PROFILES (hồ sơ + số dư từng user) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  phone text,
  balance bigint not null default 0,
  is_admin boolean not null default false,
  discord_id text,
  created_at timestamptz not null default now()
);

-- Nếu bảng profiles đã tồn tại từ trước (đã chạy file này rồi), chạy riêng dòng dưới
-- để thêm cột discord_id mà không mất dữ liệu cũ:
-- alter table public.profiles add column if not exists discord_id text;

-- Tự động tạo 1 dòng profiles khi có user đăng ký mới (kể cả qua taikhoan.html)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, phone)
  values (new.id, new.email, new.phone)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- 2. BẢNG PURCHASES (lịch sử mua dịch vụ) ----------
create table if not exists public.purchases (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  service_name text not null,
  amount bigint not null,
  created_at timestamptz not null default now()
);

-- ---------- 3. BẢNG DEPOSITS (lịch sử nạp tiền đã được duyệt) ----------
create table if not exists public.deposits (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount bigint not null,
  note text,
  created_at timestamptz not null default now()
);

-- ---------- 4. BẢNG CARD_QUEUE (hàng chờ duyệt: thẻ cào + chuyển khoản) ----------
create table if not exists public.card_queue (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  type text not null check (type in ('card','bank')),
  network text,           -- nhà mạng, chỉ dùng khi type = 'card'
  amount bigint not null,
  code text,               -- mã thẻ cào
  seri text,                -- seri thẻ cào
  memo text,                -- nội dung chuyển khoản, chỉ dùng khi type = 'bank'
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  admin_note text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------- 5. BẢNG SERVICE_STATUS (Hoạt Động / Bảo Trì) ----------
create table if not exists public.service_status (
  service_id text primary key,
  is_active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- 5b. BẢNG SERVICE_PRICES (giá tiền từng dịch vụ, do Admin chỉnh) ----------
create table if not exists public.service_prices (
  service_id text primary key,
  price bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------- 6. BẢNG ADMIN_ACTIONS (nhật ký cộng/trừ tiền thủ công) ----------
create table if not exists public.admin_actions (
  id bigserial primary key,
  admin_id uuid not null references public.profiles(id),
  target_user_id uuid not null references public.profiles(id),
  amount bigint not null,       -- dương = cộng tiền, âm = thu hồi
  note text,
  created_at timestamptz not null default now()
);

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
alter table public.profiles enable row level security;
alter table public.purchases enable row level security;
alter table public.deposits enable row level security;
alter table public.card_queue enable row level security;
alter table public.service_status enable row level security;
alter table public.service_prices enable row level security;
alter table public.admin_actions enable row level security;

-- Hàm tiện ích kiểm tra quyền admin của người đang đăng nhập
create or replace function public.is_admin()
returns boolean
language sql
security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- profiles: user xem được hồ sơ của chính mình; admin xem được tất cả
drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

-- Không cho phép update trực tiếp từ client (mọi thay đổi số dư đi qua RPC bên dưới)

-- purchases: user xem lịch sử của chính mình; admin xem tất cả
drop policy if exists "purchases_select_own_or_admin" on public.purchases;
create policy "purchases_select_own_or_admin" on public.purchases
  for select using (auth.uid() = user_id or public.is_admin());

-- deposits: tương tự
drop policy if exists "deposits_select_own_or_admin" on public.deposits;
create policy "deposits_select_own_or_admin" on public.deposits
  for select using (auth.uid() = user_id or public.is_admin());

-- card_queue: user thấy đơn của mình; admin thấy tất cả
drop policy if exists "card_queue_select_own_or_admin" on public.card_queue;
create policy "card_queue_select_own_or_admin" on public.card_queue
  for select using (auth.uid() = user_id or public.is_admin());

-- service_status: ai cũng đọc được (kể cả khách chưa đăng nhập, để hiện trạng Bảo Trì)
drop policy if exists "service_status_select_all" on public.service_status;
create policy "service_status_select_all" on public.service_status
  for select using (true);

-- service_prices: ai cũng đọc được (để trang dịch vụ hiện đúng giá hiện tại)
drop policy if exists "service_prices_select_all" on public.service_prices;
create policy "service_prices_select_all" on public.service_prices
  for select using (true);

-- admin_actions: chỉ admin xem được
drop policy if exists "admin_actions_select_admin_only" on public.admin_actions;
create policy "admin_actions_select_admin_only" on public.admin_actions
  for select using (public.is_admin());

-- =====================================================================
-- CÁC HÀM RPC (chạy với quyền cao hơn RLS, tự kiểm tra quyền bên trong)
-- =====================================================================

-- ---- Mua dịch vụ: kiểm tra số dư + trừ tiền + lưu lịch sử, atomic ----
create or replace function public.make_purchase(p_service_name text, p_amount bigint)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_discord_id text;
begin
  if v_uid is null then
    raise exception 'Chưa đăng nhập';
  end if;
  if p_amount <= 0 then
    raise exception 'Số tiền không hợp lệ';
  end if;

  select discord_id into v_discord_id from public.profiles where id = v_uid;
  if v_discord_id is null or length(trim(v_discord_id)) = 0 then
    raise exception 'THIEU_DISCORD_ID';
  end if;

  select balance into v_balance from public.profiles where id = v_uid for update;

  if v_balance is null or v_balance < p_amount then
    return false; -- không đủ số dư
  end if;

  update public.profiles set balance = balance - p_amount where id = v_uid;
  insert into public.purchases (user_id, service_name, amount) values (v_uid, p_service_name, p_amount);

  return true;
end;
$$;

-- ---- Gửi thẻ cào lên hàng chờ duyệt ----
create or replace function public.submit_card(p_network text, p_value bigint, p_code text, p_seri text)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id bigint;
begin
  if v_uid is null then raise exception 'Chưa đăng nhập'; end if;
  insert into public.card_queue (user_id, type, network, amount, code, seri)
  values (v_uid, 'card', p_network, p_value, p_code, p_seri)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---- Gửi yêu cầu xác nhận đã chuyển khoản ngân hàng lên hàng chờ duyệt ----
create or replace function public.submit_bank_claim(p_amount bigint, p_memo text)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id bigint;
begin
  if v_uid is null then raise exception 'Chưa đăng nhập'; end if;
  insert into public.card_queue (user_id, type, amount, memo)
  values (v_uid, 'bank', p_amount, p_memo)
  returning id into v_id;
  return v_id;
end;
$$;

-- ---- User tự cập nhật ID Discord của chính mình ----
-- (Client phải re-auth bằng mật khẩu qua supabase.auth.signInWithPassword
--  TRƯỚC khi gọi hàm này, để đảm bảo đúng là chủ tài khoản mới đổi được.
--  ID Discord này sẽ hiện ra trong bảng ADMIN mỗi khi user mua dịch vụ,
--  giúp Admin biết cách liên hệ khách qua Discord.)
create or replace function public.update_discord_id(p_discord_id text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Chưa đăng nhập';
  end if;
  if p_discord_id is null or length(trim(p_discord_id)) = 0 then
    raise exception 'ID Discord không hợp lệ';
  end if;

  update public.profiles set discord_id = trim(p_discord_id) where id = v_uid;

  return true;
end;
$$;

-- ---- Admin duyệt / từ chối 1 đơn trong hàng chờ ----
create or replace function public.admin_review_card(p_card_id bigint, p_approve boolean, p_note text default null)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_row public.card_queue%rowtype;
begin
  if not public.is_admin() then raise exception 'Không có quyền admin'; end if;

  select * into v_row from public.card_queue where id = p_card_id for update;
  if v_row.id is null then return false; end if;
  if v_row.status <> 'pending' then return false; end if;

  if p_approve then
    update public.profiles set balance = balance + v_row.amount where id = v_row.user_id;
    insert into public.deposits (user_id, amount, note)
    values (v_row.user_id, v_row.amount,
      case when v_row.type = 'card' then 'Nạp thẻ cào ' || coalesce(v_row.network,'') else 'Chuyển khoản ngân hàng' end);
    update public.card_queue set status = 'approved', admin_note = p_note, reviewed_by = auth.uid(), reviewed_at = now()
      where id = p_card_id;
  else
    update public.card_queue set status = 'rejected', admin_note = p_note, reviewed_by = auth.uid(), reviewed_at = now()
      where id = p_card_id;
  end if;

  return true;
end;
$$;

-- ---- Admin bật / tắt trạng thái 1 dịch vụ ----
create or replace function public.admin_set_service_status(p_service_id text, p_active boolean)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Không có quyền admin'; end if;
  insert into public.service_status (service_id, is_active, updated_at)
  values (p_service_id, p_active, now())
  on conflict (service_id) do update set is_active = p_active, updated_at = now();
  return true;
end;
$$;

-- ---- Admin chỉnh giá 1 dịch vụ ----
create or replace function public.admin_set_service_price(p_service_id text, p_price bigint)
returns boolean
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Không có quyền admin'; end if;
  if p_price < 0 then raise exception 'Giá không hợp lệ'; end if;
  insert into public.service_prices (service_id, price, updated_at)
  values (p_service_id, p_price, now())
  on conflict (service_id) do update set price = p_price, updated_at = now();
  return true;
end;
$$;

-- ---- Admin cộng / trừ tiền thủ công cho 1 user ----
create or replace function public.admin_adjust_balance(p_user_id uuid, p_amount bigint, p_note text default null)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_balance bigint;
begin
  if not public.is_admin() then raise exception 'Không có quyền admin'; end if;
  if p_amount = 0 then return false; end if;

  select balance into v_balance from public.profiles where id = p_user_id for update;
  if v_balance is null then return false; end if;
  if v_balance + p_amount < 0 then return false; end if; -- không cho âm số dư

  update public.profiles set balance = balance + p_amount where id = p_user_id;
  insert into public.admin_actions (admin_id, target_user_id, amount, note)
  values (auth.uid(), p_user_id, p_amount, p_note);

  return true;
end;
$$;

-- ---- Admin tìm kiếm user theo email / số điện thoại ----
create or replace function public.search_users(p_query text)
returns table (id uuid, email text, phone text, balance bigint, is_admin boolean, created_at timestamptz)
language sql
security definer set search_path = public
as $$
  select p.id, p.email, p.phone, p.balance, p.is_admin, p.created_at
  from public.profiles p
  where public.is_admin()
    and (p.email ilike '%' || p_query || '%' or p.phone ilike '%' || p_query || '%')
  order by p.created_at desc
  limit 50;
$$;

-- =====================================================================
-- BẬT REALTIME cho 2 bảng để ADMIN PANEL (admin.html) nhận thông báo
-- tức thời mỗi khi có ĐƠN MUA DỊCH VỤ mới hoặc YÊU CẦU NẠP TIỀN mới,
-- không cần bấm "Làm mới" thủ công mới thấy khách vừa mua/nạp.
-- =====================================================================
alter publication supabase_realtime add table public.purchases;
alter publication supabase_realtime add table public.card_queue;

-- =====================================================================
-- GIÁ MẶC ĐỊNH CHO TỪNG DỊCH VỤ (Admin có thể chỉnh lại sau trong
-- admin.html > tab "Dịch vụ"). Chạy 1 lần, nếu đã có giá rồi thì bỏ qua
-- nhờ "on conflict do nothing".
-- =====================================================================
insert into public.service_prices (service_id, price) values
  ('svc_install_driver', 120000),
  ('svc_install_optimize', 170000),
  ('svc_driver_only', 35000),
  ('svc_fix_error', 70000),
  ('svc_fps', 70000),
  ('svc_advice', 40000),
  ('mc_mod_shader', 50000),
  ('mc_fix_crash', 40000),
  ('mc_fix_mod', 80000),
  ('mc_setup_server', 350000),
  ('mc_plugin', 100000),
  ('mc_modpack', 100000),
  ('dc_setup_server', 120000),
  ('dc_setup_bot', 60000),
  ('dc_nitro_1m', 50000),
  ('dc_nitro_3m', 130000),
  ('dc_nitro_6m', 240000),
  ('dc_nitro_1y', 420000)
on conflict (service_id) do nothing;

-- NẾU DATABASE ĐÃ CÓ SẴN TỪ TRƯỚC (chưa có bảng service_prices + hàm
-- admin_set_service_price + cột discord_id bắt buộc khi mua hàng),
-- chỉ cần chạy riêng đoạn sau trong SQL Editor:
--
--    create table if not exists public.service_prices (
--      service_id text primary key,
--      price bigint not null default 0,
--      updated_at timestamptz not null default now()
--    );
--    alter table public.service_prices enable row level security;
--    create policy "service_prices_select_all" on public.service_prices for select using (true);
--
--    create or replace function public.admin_set_service_price(p_service_id text, p_price bigint)
--    returns boolean language plpgsql security definer set search_path = public as $$
--    begin
--      if not public.is_admin() then raise exception 'Không có quyền admin'; end if;
--      if p_price < 0 then raise exception 'Giá không hợp lệ'; end if;
--      insert into public.service_prices (service_id, price, updated_at)
--      values (p_service_id, p_price, now())
--      on conflict (service_id) do update set price = p_price, updated_at = now();
--      return true;
--    end;
--    $$;
--
-- (đoạn insert giá mặc định ở trên cũng chạy lại được an toàn nhờ
-- "on conflict do nothing".)
--
-- =====================================================================
-- SAU KHI CHẠY FILE NÀY:
-- 1. Đăng ký 1 tài khoản bình thường qua taikhoan.html (chính là tài khoản admin của bạn).
-- 2. Vào Supabase > SQL Editor, chạy lệnh dưới đây (thay email cho đúng) để cấp quyền admin:
--
--    update public.profiles set is_admin = true where email = 'email_cua_ban@gmail.com';
--
-- 3. Đăng nhập tài khoản đó ở admin.html để vào bảng điều khiển.
--
-- LƯU Ý: Nếu bạn đã chạy file này TRƯỚC ĐÓ RỒI (đã có sẵn database),
-- thì không cần chạy lại toàn bộ, chỉ cần chạy riêng 2 dòng sau trong
-- SQL Editor để bật tính năng thông báo tức thời cho Admin:
--
--    alter publication supabase_realtime add table public.purchases;
--    alter publication supabase_realtime add table public.card_queue;
--
-- (Nếu báo lỗi "relation is already member of publication" nghĩa là
-- realtime đã được bật sẵn rồi, bỏ qua lỗi đó là được.)
--
-- NẾU DATABASE ĐÃ CÓ SẴN TỪ TRƯỚC (chưa có cột discord_id + hàm update_discord_id),
-- chỉ cần chạy riêng đoạn sau trong SQL Editor để bổ sung tính năng "Nhập ID Discord":
--
--    alter table public.profiles add column if not exists discord_id text;
--
--    create or replace function public.update_discord_id(p_discord_id text)
--    returns boolean
--    language plpgsql
--    security definer set search_path = public
--    as $$
--    declare
--      v_uid uuid := auth.uid();
--    begin
--      if v_uid is null then raise exception 'Chưa đăng nhập'; end if;
--      if p_discord_id is null or length(trim(p_discord_id)) = 0 then
--        raise exception 'ID Discord không hợp lệ';
--      end if;
--      update public.profiles set discord_id = trim(p_discord_id) where id = v_uid;
--      return true;
--    end;
--    $$;
-- =====================================================================
