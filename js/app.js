/* TindahanTrack 2.0. Every write goes through RLS-protected tables or the secure database functions. */
(async () => {
  const admin = await Auth.guard();
  if (!admin) return;

  const $ = s => document.querySelector(s);
  const money = n => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const r2 = n => Math.round(n * 100) / 100;
  const sum = (rows, k) => (rows || []).reduce((s, r) => s + Number(r[k] || 0), 0);
  const errText = e => (e?.code === '23503' ? 'This product has sales records, so it cannot be deleted.' : e?.message) || 'Something went wrong.';
  const empty = m => `<p class="muted center">${m}</p>`;
  const card = (l, v, s = '') => `<div class="card stat"><small>${l}</small><b>${v}</b>${s ? `<span class="muted">${s}</span>` : ''}</div>`;
  const stockBadge = p => p.stock <= 0 ? '<span class="badge out">Out of stock</span>'
    : p.stock <= p.min_stock ? '<span class="badge low">Low stock</span>' : '<span class="badge ok">In stock</span>';
  const todayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
  const toast = (msg, type = 'ok') => {
    const t = document.createElement('div');
    t.className = 'toast ' + type; t.textContent = msg;
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3200);
  };
  const openModal = (title, html) => {
    $('#modalTitle').textContent = title; $('#modalBody').innerHTML = html;
    $('#modal').classList.add('open'); lucide.createIcons();
  };
  const closeModal = () => $('#modal').classList.remove('open');

  let store = { store_name: 'Sari-Sari Store', address: '', contact: '', receipt_footer: 'Salamat po!' };
  let products = [], customers = [], catList = [], rowsU = [];
  let cart = [], method = 'cash', custId = '', cash = 0, pendingReq = null, busy = false;
  let current = 'dashboard', onFilter = null, lastReceipt = '';

  async function loadCore() {
    const [p, c] = await Promise.all([
      sb.from('products').select('*, categories(name)').order('name'),
      sb.from('customers').select('id, name, contact, address').order('name'),
    ]);
    if (p.error || c.error) throw p.error || c.error;
    products = p.data; customers = c.data;
  }

  /* ---------- Dashboard ---------- */
  async function dashboard(v) {
    const [tx, pays, prods, debts, items, recent] = await Promise.all([
      sb.from('transactions').select('total, amount_paid').gte('created_at', todayStart()),
      sb.from('debt_payments').select('amount').gte('created_at', todayStart()),
      sb.from('products').select('name, stock, min_stock'),
      sb.from('debts').select('remaining_balance'),
      sb.from('transaction_items').select('qty, unit_price, unit_cost'),
      sb.from('transactions').select('txn_id, total, created_at').order('created_at', { ascending: false }).limit(5),
    ]);
    const bad = [tx, pays, prods, debts, items, recent].find(r => r.error);
    if (bad) throw bad.error;
    const low = prods.data.filter(p => p.stock <= p.min_stock);
    const profit = items.data.reduce((s, i) => s + i.qty * (i.unit_price - i.unit_cost), 0);
    v.innerHTML = `<h1>Dashboard</h1><p class="sub">Figures come straight from your saved records.</p>
      <div class="grid cards">
        ${card("Today's Revenue", money(sum(tx.data, 'total')), 'includes utang sales')}
        ${card("Today's Cash Collected", money(sum(tx.data, 'amount_paid') + sum(pays.data, 'amount')), 'sales paid plus utang payments')}
        ${card('Total Products', prods.data.length)}
        ${card('Low Stock Products', low.length)}
        ${card('Outstanding Utang', money(sum(debts.data, 'remaining_balance')))}
        ${card('Estimated Profit', money(profit), 'selling minus buying price, all time')}
      </div>
      <div class="split">
        <div class="card"><h3>Low-stock alerts</h3>
          ${low.length ? `<ul class="list">${low.map(p => `<li><span>${esc(p.name)}</span>${stockBadge(p)}</li>`).join('')}</ul>` : empty('All products are well stocked.')}</div>
        <div class="card"><h3>Recent transactions</h3>
          ${recent.data.length ? `<ul class="list">${recent.data.map(t => `<li><span>${t.txn_id}<br><small class="muted">${new Date(t.created_at).toLocaleString('en-PH')}</small></span><b>${money(t.total)}</b></li>`).join('')}</ul>` : empty('No sales yet.')}</div>
      </div>
      <div class="row"><a class="btn" href="#pos">New sale</a><a class="btn ghost" href="#products">Products &amp; stock</a><a class="btn ghost" href="#utang">Record payment</a></div>`;
  }

  /* ---------- Point of Sale ---------- */
  const cartTotal = () => r2(cart.reduce((s, i) => s + i.qty * i.price, 0));
  const changeText = () => { const t = cartTotal(); return cash >= t ? money(cash - t) : 'Short ' + money(t - cash); };

  async function pos(v) {
    await loadCore();
    const cats = [...new Set(products.map(p => p.categories?.name).filter(Boolean))].sort();
    v.innerHTML = `<h1>Point of Sale</h1><p class="sub">Tap products to add them to the cart.</p>
      <div class="pos">
        <div class="card">
          <div class="row"><input id="q" type="search" placeholder="Search product…">
            <select id="cat"><option value="">All categories</option>${cats.map(c => `<option>${esc(c)}</option>`).join('')}</select></div>
          <div class="pgrid" id="grid"></div>
        </div>
        <div class="card" id="cart"></div>
      </div>`;
    onFilter = drawGrid; drawGrid(); drawCart();
  }

  function drawGrid() {
    const q = ($('#q')?.value || '').trim().toLowerCase(), cat = $('#cat')?.value || '';
    const rows = products.filter(p => p.name.toLowerCase().includes(q) && (!cat || p.categories?.name === cat));
    $('#grid').innerHTML = rows.length ? rows.map(p => {
      const left = p.stock - (cart.find(i => i.id === p.id)?.qty || 0);
      return `<button class="pcard" data-act="add" data-id="${p.id}" ${left <= 0 ? 'disabled' : ''}>
        <b>${esc(p.name)}</b><span class="price">${money(p.selling_price)}</span>
        <small class="${left <= 0 ? 'red' : 'muted'}">${left <= 0 ? 'Out of stock' : left + ' ' + esc(p.unit) + ' left'}</small></button>`;
    }).join('') : empty('No products match.');
  }

  function addToCart(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const line = cart.find(i => i.id === id);
    if ((line?.qty || 0) + 1 > p.stock) return toast(`Only ${p.stock} ${p.unit} of ${p.name} in stock.`, 'err');
    if (line) line.qty++; else cart.push({ id, name: p.name, price: p.selling_price, qty: 1 });
    drawGrid(); drawCart();
  }

  function changeQty(id, d) {
    const line = cart.find(i => i.id === id), p = products.find(x => x.id === id);
    if (!line) return;
    const n = line.qty + d;
    if (n > (p?.stock ?? 0)) return toast('Not enough stock.', 'err');
    if (n <= 0) cart = cart.filter(i => i !== line); else line.qty = n;
    drawGrid(); drawCart();
  }

  function drawCart() {
    const el = $('#cart'); if (!el) return;
    const t = cartTotal();
    el.innerHTML = `<div class="row between"><h3>Cart</h3>${cart.length ? '<button class="btn ghost sm" data-act="clear">Clear</button>' : ''}</div>
      ${cart.length ? cart.map(i => `<div class="cline"><div><b>${esc(i.name)}</b><br><small class="muted">${money(i.price)} each</small></div>
        <div class="qty"><button class="icon-btn" data-act="qty" data-id="${i.id}" data-d="-1">−</button><span>${i.qty}</span>
        <button class="icon-btn" data-act="qty" data-id="${i.id}" data-d="1">+</button>
        <button class="icon-btn red" data-act="rm" data-id="${i.id}">✕</button></div></div>`).join('') : empty('Cart is empty.')}
      <div class="tot"><span>Subtotal</span><span>${money(t)}</span></div>
      <div class="tot big"><span>Total</span><span>${money(t)}</span></div>
      <div class="seg" style="margin-top:12px">${[['cash', 'Cash'], ['utang', 'Utang'], ['partial', 'Partial']].map(([k, l]) =>
        `<button class="${method === k ? 'on' : ''}" data-act="method" data-m="${k}">${l}</button>`).join('')}</div>
      ${method !== 'cash' ? `<label>Customer<select id="cust"><option value="">Select customer…</option>
        ${customers.map(c => `<option value="${c.id}" ${c.id === custId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>` : ''}
      ${method !== 'utang' ? `<label>${method === 'cash' ? 'Cash received (₱)' : 'Amount paid now (₱)'}
        <input id="cash" type="number" min="0" step="0.01" value="${cash || ''}"></label>` : ''}
      ${method === 'cash' ? `<div class="tot"><span>Sukli (change)</span><b id="chg">${changeText()}</b></div>` : ''}
      <button class="btn full" data-act="checkout" style="margin-top:12px" ${cart.length && !busy ? '' : 'disabled'}>${busy ? 'Saving…' : 'Complete sale'}</button>`;
  }

  const receiptHTML = r => `<div class="rcpt">
    <h3 class="center">${esc(store.store_name)}</h3>
    ${store.address ? `<p class="center">${esc(store.address)}</p>` : ''}
    ${store.contact ? `<p class="center">${esc(store.contact)}</p>` : ''}
    <small>${esc(r.txn)} · ${new Date().toLocaleString('en-PH')}</small><hr>
    ${r.items.map(i => `<div class="ln"><span>${esc(i.name)}<br><small>${i.qty} × ${money(i.price)}</small></span><span>${money(i.qty * i.price)}</span></div>`).join('')}
    <hr>
    <div class="ln"><span>Subtotal</span><span>${money(r.total)}</span></div>
    <div class="ln"><b>Total</b><b>${money(r.total)}</b></div>
    <div class="ln"><span>Payment method</span><span>${r.method[0].toUpperCase() + r.method.slice(1)}</span></div>
    <div class="ln"><span>Amount paid</span><span>${money(r.paid)}</span></div>
    <div class="ln"><span>Remaining balance</span><span>${money(r.remaining)}</span></div>
    ${r.change > 0 ? `<div class="ln"><span>Sukli</span><span>${money(r.change)}</span></div>` : ''}
    ${r.custName ? `<div>Customer: ${esc(r.custName)}</div>` : ''}
    <p class="center">${esc(store.receipt_footer)}</p></div>`;

  async function checkout() {
    if (busy) return;
    if (!cart.length) return toast('Add at least one product.', 'err');
    if (method !== 'cash' && !custId) return toast('Select a customer for utang or partial payment.', 'err');
    const total = cartTotal(), items = cart.map(i => ({ ...i }));
    busy = true; drawCart();
    pendingReq ||= crypto.randomUUID();   // same key on retry, so a repeated submit cannot charge twice
    const { data, error } = await sb.rpc('create_sale', {
      p_client_request_id: pendingReq,
      p_customer_id: method === 'cash' ? null : custId,
      p_payment_method: method,
      p_items: cart.map(i => ({ product_id: i.id, qty: i.qty })),
      p_amount_paid: method === 'utang' ? 0 : cash,
    });
    busy = false;
    if (error) { toast(error.message, 'err'); return drawCart(); }
    const done = pendingReq; pendingReq = null;
    const custName = customers.find(c => c.id === custId)?.name || '';
    const usedMethod = method;
    cart = []; cash = 0; custId = ''; method = 'cash';
    if (data.duplicate) { toast('This sale was already saved.'); return route(); }
    lastReceipt = receiptHTML({ txn: data.txn_id, items, total, method: usedMethod, paid: data.paid, change: data.change, remaining: data.remaining, custName });
    openModal('Sale complete', lastReceipt + `<div class="row" style="margin-top:12px">
      <button class="btn" data-act="print">Print receipt</button><button class="btn ghost" data-act="close">New sale</button></div>`);
    toast(`${data.txn_id} saved. Stock updated.`);
    route();
  }

  /* ---------- Products & stock ---------- */
  async function productsPage(v) {
    await loadCore();
    const c = await sb.from('categories').select('id, name').order('name');
    if (c.error) throw c.error;
    catList = c.data;
    v.innerHTML = `<div class="row between"><div><h1>Products &amp; Stock</h1>
        <p class="sub">Prices, profit, and stock. Every stock change is logged.</p></div>
        <button class="btn" data-act="p-new">+ Add product</button></div>
      <div class="row"><input id="q" type="search" placeholder="Search name or SKU…">
        <select id="cat"><option value="">All categories</option>${catList.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
        <select id="st"><option value="">All stock</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select></div>
      <div class="card tablewrap" id="list"></div>`;
    onFilter = drawProducts; drawProducts();
  }

  function drawProducts() {
    const q = ($('#q')?.value || '').trim().toLowerCase(), cat = $('#cat')?.value || '', st = $('#st')?.value || '';
    const rows = products.filter(p => (p.name + ' ' + (p.sku || '')).toLowerCase().includes(q)
      && (!cat || p.category_id === cat)
      && (!st || (st === 'out' ? p.stock <= 0 : st === 'low' ? p.stock > 0 && p.stock <= p.min_stock : p.stock > p.min_stock)));
    $('#list').innerHTML = rows.length ? `<table><thead><tr><th>Product</th><th>Category</th><th>Buying</th><th>Selling</th>
      <th>Profit / margin</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(p => {
        const pr = p.selling_price - p.buying_price;
        const mg = p.selling_price > 0 ? (pr / p.selling_price * 100).toFixed(1) + '%' : '—';
        return `<tr><td><b>${esc(p.name)}</b><br><small class="muted">${esc(p.sku || 'No SKU')} · per ${esc(p.unit)}</small></td>
          <td>${esc(p.categories?.name || '—')}</td><td>${money(p.buying_price)}</td><td>${money(p.selling_price)}</td>
          <td class="${pr < 0 ? 'red' : 'green'}">${money(pr)} <small class="muted">${mg}</small></td>
          <td>${p.stock}</td><td>${stockBadge(p)}</td>
          <td class="acts"><button class="btn ghost sm" data-act="stock" data-id="${p.id}">Stock</button>
            <button class="btn ghost sm" data-act="p-edit" data-id="${p.id}">Edit</button>
            <button class="btn ghost sm" data-act="p-del" data-id="${p.id}">Delete</button></td></tr>`;
      }).join('')}</tbody></table>` : empty('No products match.');
  }

  function productForm(p = {}) {
    return `<form class="form" data-form="product" data-id="${p.id || ''}">
      <label>Product name<input name="name" required value="${esc(p.name)}"></label>
      <div class="two-col">
        <label>SKU / barcode <span class="muted">(optional)</span><input name="sku" value="${esc(p.sku)}"></label>
        <label>Category<select name="category_id"><option value="">No category</option>
          ${catList.map(c => `<option value="${c.id}" ${c.id === p.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      </div>
      <div class="two-col">
        <label>Buying price (₱)<input name="buying" type="number" min="0" step="0.01" required value="${p.buying_price ?? ''}"></label>
        <label>Selling price (₱)<input name="selling" type="number" min="0" step="0.01" required value="${p.selling_price ?? ''}"></label>
      </div>
      <div class="two-col">
        ${p.id ? `<label>Current stock<input disabled value="${p.stock}"></label>`
               : `<label>Opening stock<input name="stock" type="number" min="0" step="1" value="0" required></label>`}
        <label>Unit<input name="unit" value="${esc(p.unit || 'piece')}"></label>
      </div>
      <label>Minimum stock (low-stock alert)<input name="min" type="number" min="0" step="1" required value="${p.min_stock ?? 5}"></label>
      <button class="btn full" type="submit">${p.id ? 'Save changes' : 'Add product'}</button></form>`;
  }

  async function saveProduct(f) {
    const d = new FormData(f), id = f.dataset.id;
    const row = {
      name: String(d.get('name')).trim(), sku: String(d.get('sku')).trim() || null,
      category_id: d.get('category_id') || null, buying_price: r2(+d.get('buying')), selling_price: r2(+d.get('selling')),
      unit: String(d.get('unit')).trim() || 'piece', min_stock: Math.floor(+d.get('min')), updated_at: new Date().toISOString(),
    };
    const stock = Math.floor(+d.get('stock') || 0);
    if (!row.name) return toast('Product name is required.', 'err');
    if (![row.buying_price, row.selling_price, row.min_stock].every(n => Number.isFinite(n) && n >= 0))
      return toast('Prices and minimum stock must be zero or higher.', 'err');
    const res = id ? await sb.from('products').update(row).eq('id', id)
                   : await sb.from('products').insert({ ...row, stock: Math.max(stock, 0) });
    if (res.error) return toast(errText(res.error), 'err');
    closeModal(); toast(id ? 'Product updated.' : 'Product added.'); route();
  }

  function stockForm(p) {
    return `<form class="form" data-form="stock" data-id="${p.id}">
      <p>Current stock: <b>${p.stock} ${esc(p.unit)}</b></p>
      <label>Movement<select name="type">
        <option value="stock_in">Stock in (add)</option>
        <option value="stock_out">Stock out (remove)</option>
        <option value="adjustment">Adjustment (set to counted quantity)</option></select></label>
      <label>Quantity<input name="qty" type="number" min="0" step="1" required></label>
      <label>Reason<input name="reason" placeholder="e.g. delivery, spoiled, physical count"></label>
      <button class="btn full" type="submit">Save</button></form>`;
  }

  async function saveStock(f) {
    if (busy) return;
    busy = true;
    const d = new FormData(f);
    const { data, error } = await sb.rpc('adjust_stock', {
      p_product_id: f.dataset.id, p_movement_type: d.get('type'),
      p_qty: Math.floor(+d.get('qty')), p_reason: String(d.get('reason') || ''),
    });
    busy = false;
    if (error) return toast(error.message, 'err');
    closeModal(); toast(`Stock updated. New stock: ${data}.`); route();
  }

  /* ---------- Utang & customers ---------- */
  async function utang(v) {
    const [c, d] = await Promise.all([
      sb.from('customers').select('id, name, contact, address').order('name'),
      sb.from('debts').select('customer_id, amount, amount_paid, remaining_balance'),
    ]);
    if (c.error || d.error) throw c.error || d.error;
    customers = c.data;
    const agg = {};
    d.data.forEach(x => {
      const a = agg[x.customer_id] ||= { borrowed: 0, paid: 0, remaining: 0 };
      a.borrowed += +x.amount; a.paid += +x.amount_paid; a.remaining += +x.remaining_balance;
    });
    rowsU = customers.map(x => ({ ...x, ...(agg[x.id] || { borrowed: 0, paid: 0, remaining: 0 }) }));
    v.innerHTML = `<div class="row between"><div><h1>Utang &amp; Customers</h1>
        <p class="sub">Balances and payments. Credit sales are recorded in Point of Sale.</p></div>
        <button class="btn" data-act="c-new">+ Add customer</button></div>
      <div class="grid cards">${card('Outstanding utang', money(rowsU.reduce((s, r) => s + r.remaining, 0)))}
        ${card('Customers with balance', rowsU.filter(r => r.remaining > 0).length)}</div>
      <div class="row"><input id="q" type="search" placeholder="Search name or contact…">
        <select id="st"><option value="">All accounts</option><option value="open">Unpaid or partial</option><option value="paid">Fully paid</option></select></div>
      <div class="card tablewrap" id="list"></div>`;
    onFilter = drawUtang; drawUtang();
  }

  function drawUtang() {
    const q = ($('#q')?.value || '').trim().toLowerCase(), st = $('#st')?.value || '';
    const rows = rowsU.filter(r => (r.name + ' ' + r.contact).toLowerCase().includes(q)
      && (!st || (st === 'open' ? r.remaining > 0 : r.borrowed > 0 && r.remaining <= 0)));
    $('#list').innerHTML = rows.length ? `<table><thead><tr><th>Customer</th><th>Borrowed</th><th>Paid</th><th>Remaining</th><th>Status</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td><b>${esc(r.name)}</b><br><small class="muted">${esc(r.contact)}${r.address ? ' · ' + esc(r.address) : ''}</small></td>
        <td>${money(r.borrowed)}</td><td>${money(r.paid)}</td><td><b>${money(r.remaining)}</b></td>
        <td>${r.borrowed === 0 ? '<span class="badge ok">No utang</span>' : r.remaining <= 0 ? '<span class="badge ok">Paid</span>'
          : r.paid > 0 ? '<span class="badge low">Partial</span>' : '<span class="badge out">Unpaid</span>'}</td>
        <td>${r.remaining > 0 ? `<button class="btn sm" data-act="pay" data-id="${r.id}">Record payment</button>` : ''}</td></tr>`).join('')}
      </tbody></table>` : empty('No customers match.');
  }

  function openPay(id) {
    const r = rowsU.find(x => x.id === id);
    if (!r || r.remaining <= 0) return toast('This customer has no balance.', 'err');
    openModal('Record payment: ' + r.name, `<form class="form" data-form="pay" data-id="${id}" data-req="${crypto.randomUUID()}">
      <p>Remaining balance: <b>${money(r.remaining)}</b></p>
      <label>Amount received (₱)<input name="amount" type="number" min="0.01" max="${r.remaining}" step="0.01" required value="${r.remaining.toFixed(2)}"></label>
      <p class="muted">Keep the full balance for a full payment, or lower it for a partial payment.</p>
      <label>Note<input name="note" placeholder="e.g. partial payment"></label>
      <button class="btn full" type="submit">Save payment</button></form>`);
  }

  async function savePayment(f) {
    if (busy) return;
    busy = true;
    const d = new FormData(f);
    const { data, error } = await sb.rpc('record_debt_payment', {
      p_client_request_id: f.dataset.req, p_customer_id: f.dataset.id,
      p_amount: r2(+d.get('amount')), p_note: String(d.get('note') || ''),
    });
    busy = false;
    if (error) return toast(error.message, 'err');
    closeModal();
    toast(data.duplicate ? 'This payment was already recorded.' : `Payment saved. Remaining balance: ${money(data.remaining)}`);
    route();
  }

  function customerForm() {
    return `<form class="form" data-form="customer">
      <label>Full name<input name="name" required></label>
      <label>Contact number<input name="contact" inputmode="tel"></label>
      <label>Address<input name="address"></label>
      <button class="btn full" type="submit">Add customer</button></form>`;
  }

  async function saveCustomer(f) {
    const d = new FormData(f);
    const row = { name: String(d.get('name')).trim(), contact: String(d.get('contact')).trim(), address: String(d.get('address')).trim() };
    if (!row.name) return toast('Customer name is required.', 'err');
    if (row.contact && !/^[0-9+\s-]{7,}$/.test(row.contact)) return toast('Enter a valid contact number.', 'err');
    const { error } = await sb.from('customers').insert(row);
    if (error) return toast(errText(error), 'err');
    closeModal(); toast('Customer added.'); route();
  }

  async function deleteProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p || !confirm(`Delete "${p.name}"? Products with sales history cannot be deleted.`)) return;
    const { error } = await sb.from('products').delete().eq('id', id);
    if (error) return toast(errText(error), 'err');
    toast('Product deleted.'); route();
  }

  /* ---------- Wiring ---------- */
  const acts = {
    close: closeModal,
    menu: () => { $('#sidebar').classList.toggle('open'); $('#overlay').classList.toggle('open'); },
    logout: () => Auth.signOut(),
    reload: () => route(),
    add: el => addToCart(el.dataset.id),
    qty: el => changeQty(el.dataset.id, +el.dataset.d),
    rm: el => { cart = cart.filter(i => i.id !== el.dataset.id); drawGrid(); drawCart(); },
    clear: () => { cart = []; cash = 0; drawGrid(); drawCart(); },
    method: el => { method = el.dataset.m; if (method === 'utang') cash = 0; drawCart(); },
    checkout: () => checkout(),
    print: () => { $('#receipt').innerHTML = lastReceipt; window.print(); },
    'p-new': () => openModal('Add product', productForm()),
    'p-edit': el => openModal('Edit product', productForm(products.find(x => x.id === el.dataset.id))),
    'p-del': el => deleteProduct(el.dataset.id),
    stock: el => { const p = products.find(x => x.id === el.dataset.id); openModal('Stock: ' + p.name, stockForm(p)); },
    'c-new': () => openModal('Add customer', customerForm()),
    pay: el => openPay(el.dataset.id),
  };
  const forms = { product: saveProduct, stock: saveStock, pay: savePayment, customer: saveCustomer };

  document.addEventListener('click', e => {
    if (e.target.id === 'modal') return closeModal();
    const el = e.target.closest('[data-act]');
    if (el && acts[el.dataset.act]) Promise.resolve(acts[el.dataset.act](el)).catch(err => toast(errText(err), 'err'));
  });
  document.addEventListener('submit', e => {
    e.preventDefault();
    const f = e.target, fn = forms[f.dataset.form];
    if (fn) fn(f).catch(err => { busy = false; toast(errText(err), 'err'); });
  });
  ['input', 'change'].forEach(ev => document.addEventListener(ev, e => {
    if (['q', 'cat', 'st'].includes(e.target.id) && onFilter) onFilter();
    if (e.target.id === 'cust') custId = e.target.value;
    if (e.target.id === 'cash') { cash = +e.target.value || 0; const c = $('#chg'); if (c) c.textContent = changeText(); }
  }));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  const pages = { dashboard, pos, products: productsPage, utang };
  async function route() {
    const h = location.hash.slice(1);
    current = Object.hasOwn(pages, h) ? h : 'dashboard';
    onFilter = null;
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.page === current));
    const view = $('#view');
    view.innerHTML = '<div class="skel"></div><div class="skel"></div>';
    try { await pages[current](view); }
    catch (e) { view.innerHTML = `<div class="card"><h3>Could not load this page</h3><p class="muted">${esc(errText(e))}</p><button class="btn" data-act="reload">Try again</button></div>`; }
    lucide.createIcons();
    $('#sidebar').classList.remove('open'); $('#overlay').classList.remove('open');
  }

  $('#who').textContent = admin.display_name || admin.email;
  const s = await sb.from('store_settings').select('*').eq('id', 1).maybeSingle();
  if (s.data) { store = s.data; $('#storeName').textContent = store.store_name; }
  window.addEventListener('hashchange', route);
  route();
})();
