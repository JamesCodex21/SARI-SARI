-- TindahanTrack 2.0, step 1 of 2: tables, administrator allowlist, Row Level Security, starter data.
-- Run in Supabase: SQL Editor > New query > paste > Run. Then run functions.sql.

create extension if not exists pgcrypto;

-- ---------- Administrators (exactly two) ----------
create table if not exists admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create or replace function enforce_two_admins() returns trigger language plpgsql as $$
begin
  if (select count(*) from admin_profiles) >= 2 then
    raise exception 'Only two administrator accounts are allowed.';
  end if;
  return new;
end $$;

drop trigger if exists trg_two_admins on admin_profiles;
create trigger trg_two_admins before insert on admin_profiles
  for each row execute function enforce_two_admins();

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admin_profiles where id = auth.uid());
$$;

-- ---------- Store settings ----------
create table if not exists store_settings (
  id int primary key default 1 check (id = 1),
  store_name text not null default 'Sari-Sari Store',
  address text not null default '',
  contact text not null default '',
  receipt_footer text not null default 'Salamat po! Balik kayo!',
  currency text not null default 'PHP',
  updated_at timestamptz not null default now()
);
insert into store_settings (id) values (1) on conflict (id) do nothing;

-- ---------- Catalog ----------
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  sku text unique,
  name text not null check (length(trim(name)) > 0),
  category_id uuid references categories(id) on delete restrict,
  buying_price numeric(12,2) not null check (buying_price >= 0),
  selling_price numeric(12,2) not null check (selling_price >= 0),
  stock integer not null default 0 check (stock >= 0),
  min_stock integer not null default 0 check (min_stock >= 0),
  unit text not null default 'piece',
  image_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  contact text not null default '',
  address text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- Sales (append-only; written only by functions.sql) ----------
create sequence if not exists txn_seq;

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  txn_id text not null unique default 'TXN-' || lpad(nextval('txn_seq')::text, 6, '0'),
  client_request_id uuid not null unique,
  customer_id uuid references customers(id) on delete restrict,
  payment_method text not null check (payment_method in ('cash','utang','partial')),
  subtotal numeric(12,2) not null check (subtotal >= 0),
  total numeric(12,2) not null check (total >= 0),
  amount_paid numeric(12,2) not null check (amount_paid >= 0),
  change_given numeric(12,2) not null default 0 check (change_given >= 0),
  remaining_balance numeric(12,2) not null default 0 check (remaining_balance >= 0),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists transaction_items (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references transactions(id) on delete restrict,
  product_id uuid not null references products(id) on delete restrict,
  product_name text not null,
  qty integer not null check (qty > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  unit_cost numeric(12,2) not null check (unit_cost >= 0),
  line_total numeric(12,2) not null check (line_total >= 0)
);
create index if not exists idx_items_txn on transaction_items(transaction_id);

-- ---------- Utang ----------
-- debts.remaining_balance is the live balance. transactions.remaining_balance is the balance at sale time.
create table if not exists debts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete restrict,
  transaction_id uuid not null unique references transactions(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  amount_paid numeric(12,2) not null default 0 check (amount_paid >= 0),
  remaining_balance numeric(12,2) not null check (remaining_balance >= 0),
  status text not null check (status in ('unpaid','partial','paid')),
  due_date date,
  created_at timestamptz not null default now(),
  check (amount_paid + remaining_balance = amount)
);
create index if not exists idx_debts_customer on debts(customer_id);

create table if not exists debt_payments (
  id uuid primary key default gen_random_uuid(),
  client_request_id uuid not null,
  customer_id uuid not null references customers(id) on delete restrict,
  debt_id uuid not null references debts(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  note text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (client_request_id, debt_id)
);

-- ---------- Inventory, expenses, audit ----------
create table if not exists inventory_logs (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete restrict,
  movement_type text not null check (movement_type in ('stock_in','stock_out','adjustment','sale')),
  qty_change integer not null,
  previous_stock integer not null check (previous_stock >= 0),
  new_stock integer not null check (new_stock >= 0),
  reason text not null default '',
  transaction_id uuid references transactions(id) on delete restrict,
  admin_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('Electricity','Water','Transportation','Store Supplies','Rent','Other Expenses')),
  description text not null check (length(trim(description)) > 0),
  amount numeric(12,2) not null check (amount > 0),
  expense_date date not null default current_date,
  notes text not null default '',
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id),
  action text not null,
  table_name text not null,
  record_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------- Row Level Security ----------
alter table admin_profiles enable row level security;
drop policy if exists admin_self_read on admin_profiles;
create policy admin_self_read on admin_profiles for select to authenticated
  using (id = auth.uid() or is_admin());
-- No insert/update/delete policies: administrators are added only from the SQL Editor.

do $$
declare t text;
begin
  -- Editable master data: admins can read and write.
  foreach t in array array['store_settings','categories','products','customers','expenses'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists admin_all on %I', t);
    execute format('create policy admin_all on %I for all to authenticated using (is_admin()) with check (is_admin())', t);
  end loop;
  -- Financial and audit records: admins can read only. Writes happen through functions.sql.
  foreach t in array array['transactions','transaction_items','debts','debt_payments','inventory_logs','audit_logs'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists admin_read on %I', t);
    execute format('create policy admin_read on %I for select to authenticated using (is_admin())', t);
  end loop;
end $$;

-- ---------- Starter data ----------
insert into categories (name) values
  ('Beverages'), ('Noodles'), ('Canned Goods'), ('Condiments'), ('Bread'),
  ('Dairy & Eggs'), ('Snacks'), ('Toiletries'), ('Others')
on conflict (name) do nothing;

insert into products (name, category_id, buying_price, selling_price, stock, min_stock, unit)
select v.name, c.id, v.bp, v.sp, v.st, v.mn, v.u
from (values
  ('Instant Noodles (Pancit Canton)', 'Noodles', 10, 14, 30, 10, 'pack'),
  ('3-in-1 Coffee', 'Beverages', 6, 9, 40, 12, 'sachet'),
  ('Sardines 155g', 'Canned Goods', 24, 30, 12, 6, 'can'),
  ('Pandesal', 'Bread', 1.5, 3, 60, 20, 'piece'),
  ('Sugar 1kg', 'Condiments', 58, 65, 8, 5, 'kg')
) as v(name, cat, bp, sp, st, mn, u)
join categories c on c.name = v.cat
where not exists (select 1 from products p where p.name = v.name);
