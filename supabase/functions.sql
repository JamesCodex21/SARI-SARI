-- TindahanTrack 2.0, step 2 of 2: secure financial functions. Run after schema.sql.
-- Every function runs as one database transaction, checks is_admin(), and is idempotent via client_request_id.

-- Stock may change only inside these functions (guard_stock blocks direct edits).
create or replace function guard_stock() returns trigger language plpgsql as $$
begin
  if new.stock <> old.stock and coalesce(current_setting('tt.stock_ok', true), '') <> 'on' then
    raise exception 'Stock changes must go through inventory functions.';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_stock on products;
create trigger trg_guard_stock before update on products
  for each row execute function guard_stock();

-- ---------- Checkout ----------
create or replace function create_sale(
  p_client_request_id uuid,
  p_customer_id uuid,
  p_payment_method text,
  p_items jsonb,
  p_amount_paid numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_txn transactions%rowtype;
  p products%rowtype;
  it jsonb;
  v_qty integer;
  v_subtotal numeric(12,2) := 0;
  v_paid numeric(12,2);
  v_change numeric(12,2) := 0;
  v_remaining numeric(12,2);
  v_before integer;
begin
  if not is_admin() then raise exception 'Not authorized.'; end if;

  -- Repeated submit with the same key returns the original sale instead of charging twice.
  select * into v_txn from transactions where client_request_id = p_client_request_id;
  if found then
    return jsonb_build_object('duplicate', true, 'txn_id', v_txn.txn_id);
  end if;

  if p_payment_method not in ('cash','utang','partial') then raise exception 'Invalid payment method.'; end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then raise exception 'The cart is empty.'; end if;
  if p_payment_method <> 'cash' and p_customer_id is null then
    raise exception 'Select a customer for utang or partial payment.';
  end if;
  if p_customer_id is not null and not exists (select 1 from customers where id = p_customer_id) then
    raise exception 'Customer not found.';
  end if;

  -- Validate and lock every product line so two checkouts cannot oversell the same stock.
  for it in select value from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::integer;
    if v_qty is null or v_qty <= 0 then raise exception 'Invalid quantity.'; end if;
    select * into p from products where id = (it->>'product_id')::uuid for update;
    if not found then raise exception 'A product in the cart no longer exists.'; end if;
    if p.stock < v_qty then raise exception 'Not enough stock for %. Only % left.', p.name, p.stock; end if;
    v_subtotal := v_subtotal + v_qty * p.selling_price;
  end loop;

  -- Payment rules. Revenue is always the full subtotal; cash collected is what was actually paid.
  if p_payment_method = 'cash' then
    if coalesce(p_amount_paid, 0) < v_subtotal then raise exception 'Cash received is less than the total.'; end if;
    v_paid := v_subtotal;
    v_change := p_amount_paid - v_subtotal;
    v_remaining := 0;
  elsif p_payment_method = 'utang' then
    v_paid := 0;
    v_remaining := v_subtotal;
  else
    if coalesce(p_amount_paid, 0) <= 0 or p_amount_paid >= v_subtotal then
      raise exception 'A partial payment must be more than zero and less than the total.';
    end if;
    v_paid := p_amount_paid;
    v_remaining := v_subtotal - p_amount_paid;
  end if;

  insert into transactions (client_request_id, customer_id, payment_method, subtotal, total,
    amount_paid, change_given, remaining_balance, created_by)
  values (p_client_request_id, p_customer_id, p_payment_method, v_subtotal, v_subtotal,
    v_paid, v_change, v_remaining, auth.uid())
  returning * into v_txn;

  if v_remaining > 0 then
    insert into debts (customer_id, transaction_id, amount, amount_paid, remaining_balance, status)
    values (p_customer_id, v_txn.id, v_subtotal, v_paid, v_remaining,
      case when v_paid > 0 then 'partial' else 'unpaid' end);
  end if;

  -- Deduct stock exactly once per line and snapshot prices for history.
  for it in select value from jsonb_array_elements(p_items) loop
    v_qty := (it->>'qty')::integer;
    select * into p from products where id = (it->>'product_id')::uuid;
    v_before := p.stock;
    perform set_config('tt.stock_ok', 'on', true);
    update products set stock = stock - v_qty, updated_at = now() where id = p.id;
    insert into transaction_items (transaction_id, product_id, product_name, qty, unit_price, unit_cost, line_total)
    values (v_txn.id, p.id, p.name, v_qty, p.selling_price, p.buying_price, v_qty * p.selling_price);
    insert into inventory_logs (product_id, movement_type, qty_change, previous_stock, new_stock, reason, transaction_id, admin_id)
    values (p.id, 'sale', -v_qty, v_before, v_before - v_qty, v_txn.txn_id, v_txn.id, auth.uid());
  end loop;

  insert into audit_logs (actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'sale.create', 'transactions', v_txn.id::text,
    jsonb_build_object('txn_id', v_txn.txn_id, 'total', v_subtotal, 'method', p_payment_method));

  return jsonb_build_object('duplicate', false, 'txn_id', v_txn.txn_id, 'total', v_subtotal,
    'paid', v_paid, 'change', v_change, 'remaining', v_remaining);
end $$;

-- ---------- Utang payments (oldest debt first, never above the balance) ----------
create or replace function record_debt_payment(
  p_client_request_id uuid,
  p_customer_id uuid,
  p_amount numeric,
  p_note text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d debts%rowtype;
  v_owed numeric(12,2);
  v_left numeric(12,2);
  v_apply numeric(12,2);
begin
  if not is_admin() then raise exception 'Not authorized.'; end if;
  if exists (select 1 from debt_payments where client_request_id = p_client_request_id) then
    return jsonb_build_object('duplicate', true);
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount greater than zero.'; end if;

  -- Serialize payments per customer so two devices cannot pay the same balance twice.
  perform 1 from customers where id = p_customer_id for update;
  if not found then raise exception 'Customer not found.'; end if;

  select coalesce(sum(remaining_balance), 0) into v_owed from debts where customer_id = p_customer_id;
  if v_owed <= 0 then raise exception 'This customer has no outstanding balance.'; end if;
  if p_amount > v_owed then raise exception 'Payment is more than the remaining balance of %.', v_owed; end if;

  v_left := p_amount;
  for d in select * from debts where customer_id = p_customer_id and remaining_balance > 0
           order by created_at for update loop
    exit when v_left <= 0;
    v_apply := least(d.remaining_balance, v_left);
    update debts set
      amount_paid = amount_paid + v_apply,
      remaining_balance = remaining_balance - v_apply,
      status = case when remaining_balance - v_apply = 0 then 'paid' else 'partial' end
    where id = d.id;
    insert into debt_payments (client_request_id, customer_id, debt_id, amount, note, created_by)
    values (p_client_request_id, p_customer_id, d.id, v_apply, coalesce(p_note, ''), auth.uid());
    v_left := v_left - v_apply;
  end loop;

  insert into audit_logs (actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'debt.payment', 'customers', p_customer_id::text, jsonb_build_object('amount', p_amount));

  return jsonb_build_object('duplicate', false, 'applied', p_amount, 'remaining', v_owed - p_amount);
end $$;

-- ---------- Stock movements (stock in, stock out, adjustment to counted quantity) ----------
create or replace function adjust_stock(
  p_product_id uuid,
  p_movement_type text,
  p_qty integer,
  p_reason text default ''
) returns integer language plpgsql security definer set search_path = public as $$
declare
  p products%rowtype;
  v_delta integer;
  v_new integer;
begin
  if not is_admin() then raise exception 'Not authorized.'; end if;
  if p_movement_type not in ('stock_in','stock_out','adjustment') then raise exception 'Invalid movement type.'; end if;
  if p_qty is null or p_qty < 0 then raise exception 'Quantity must be zero or higher.'; end if;

  select * into p from products where id = p_product_id for update;
  if not found then raise exception 'Product not found.'; end if;

  if p_movement_type = 'stock_in' then v_delta := p_qty;
  elsif p_movement_type = 'stock_out' then v_delta := -p_qty;
  else v_delta := p_qty - p.stock;
  end if;

  v_new := p.stock + v_delta;
  if v_new < 0 then raise exception 'Only % % in stock.', p.stock, p.unit; end if;

  perform set_config('tt.stock_ok', 'on', true);
  update products set stock = v_new, updated_at = now() where id = p.id;
  insert into inventory_logs (product_id, movement_type, qty_change, previous_stock, new_stock, reason, admin_id)
  values (p.id, p_movement_type, v_delta, p.stock, v_new, coalesce(p_reason, ''), auth.uid());
  insert into audit_logs (actor_id, action, table_name, record_id, details)
  values (auth.uid(), 'inventory.' || p_movement_type, 'products', p.id::text,
    jsonb_build_object('delta', v_delta, 'new_stock', v_new));
  return v_new;
end $$;

-- Only signed-in administrators may call these functions. Anonymous visitors may not.
revoke all on function create_sale(uuid, uuid, text, jsonb, numeric) from public, anon;
revoke all on function record_debt_payment(uuid, uuid, numeric, text) from public, anon;
revoke all on function adjust_stock(uuid, text, integer, text) from public, anon;
grant execute on function create_sale(uuid, uuid, text, jsonb, numeric) to authenticated;
grant execute on function record_debt_payment(uuid, uuid, numeric, text) to authenticated;
grant execute on function adjust_stock(uuid, text, integer, text) to authenticated;
