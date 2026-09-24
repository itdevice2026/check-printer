/* ===================================================================
   Supabase layer for the online (GitHub Pages) edition.
   Loaded after the core app script; replaces its storage functions.
   =================================================================== */
'use strict';
const CP_CONFIG = window.CP_CONFIG || {};
const SB = window.supabase.createClient(CP_CONFIG.supabaseUrl, CP_CONFIG.supabaseKey, {auth: {persistSession: true, autoRefreshToken: true}});
let CP_SESSION = null, CP_ROLE = null, CP_USERS = [], CP_CHANNEL = null, CP_PAYEES = [];

/* ---------- row <-> app object mapping ---------- */
const coFromRow = r => ({name: r.name, short: r.short, tin: r.tin, address: r.address, cvPrefix: r.cv_prefix, cvNext: r.cv_next, prepared: r.prepared, checked: r.checked, approved: r.approved});
const coToRow = (id, c) => ({id, name: c.name, short: c.short || '', tin: c.tin || '', address: c.address || '', cv_prefix: c.cvPrefix || 'CV', cv_next: +c.cvNext || 1, prepared: c.prepared || '', checked: c.checked || '', approved: c.approved || ''});
const acFromRow = r => ({companyId: r.company_id, bank: r.bank, branch: r.branch, name: r.name, number: r.number, brstn: r.brstn, seriesFrom: +r.series_from, seriesTo: +r.series_to, nextNo: +r.next_no, digits: r.digits, layoutId: r.layout_id, active: r.active});
const acToRow = (id, a) => ({id, company_id: a.companyId, bank: a.bank, branch: a.branch || '', name: a.name || '', number: a.number || '', brstn: a.brstn || '', series_from: +a.seriesFrom, series_to: +a.seriesTo, next_no: +a.nextNo, digits: +a.digits || 10, layout_id: a.layoutId || '', active: a.active !== false});
const ckFromRow = r => ({_id: r.id, date: r.check_date, payee: r.payee, amount: Number(r.amount), words: r.words, particulars: r.particulars, cvNo: r.cv_no, acPayee: r.ac_payee, entries: r.entries || [], status: r.status, voidReason: r.void_reason || '', printed: r.printed, companyId: r.company_id, createdAt: r.created_at, createdBy: r.created_by, createdByName: r.created_by_email, releasedAt: r.released_at, clearedAt: r.cleared_at, voidedAt: r.voided_at});
const CK_FIELDS = {status: 'status', releasedAt: 'released_at', clearedAt: 'cleared_at', voidReason: 'void_reason', voidedAt: 'voided_at', printed: 'printed', particulars: 'particulars', cvNo: 'cv_no'};

function applyRow(table, row, deleted) {
  if (!row) return;
  if (table === 'cp_companies') { const m = {...S.companies}; if (deleted) delete m[row.id]; else m[row.id] = coFromRow(row); S.companies = m; }
  else if (table === 'cp_accounts') { const m = {...S.accounts}; if (deleted) delete m[row.id]; else m[row.id] = acFromRow(row); S.accounts = m; }
  else if (table === 'cp_layouts') { const m = {...S.layouts}; if (deleted) delete m[row.id]; else m[row.id] = row.data; S.layouts = m; if (!app.layoutDirty) app.layoutDraft = null; mounted.layouts = false; }
  else if (table === 'cp_checks') {
    const m = {...S.checks};
    if (deleted) { for (const b in m) for (const no in m[b].checks) if (m[b].checks[no]._id === row.id) { m[b] = {...m[b], checks: {...m[b].checks}}; delete m[b].checks[no]; } }
    else { const bid = bucketId(row.account_id, +row.check_no); const b = m[bid] || {accountId: row.account_id, checks: {}}; m[bid] = {accountId: row.account_id, checks: {...b.checks, [+row.check_no]: ckFromRow(row)}}; }
    S.checks = m;
  }
  else if (table === 'cp_audit') { const e = {...(S.audit.all?.entries || {})}; e[row.id] = {t: row.at, by: row.user_id, byName: row.user_email, action: row.action, detail: row.detail}; S.audit = {all: {entries: e}}; }
  else if (table === 'cp_allowed_users') { CP_USERS = CP_USERS.filter(u => u.email !== row.email); if (!deleted) CP_USERS.push(row); }
  else if (table === 'cp_payees') { CP_PAYEES = CP_PAYEES.filter(p => p.id !== row.id); if (!deleted) CP_PAYEES.push(row); }
  scheduleRender();
}
function cpErr(error) {
  const e = new Error(error?.message || String(error)); e.code = error?.code;
  if (error?.code === '23505') e.message = 'That check number is already in the register.';
  if (error?.code === '42501' || error?.code === 'PGRST116') e.message = 'You don\u2019t have permission to change this record.';
  return e;
}
async function must(q) { const {data, error} = await q; if (error) throw cpErr(error); return data; }

/* ---------- storage functions used by the app ---------- */
put = async function (col, id, data) {
  if (col === 'companies') return applyRow('cp_companies', (await must(SB.from('cp_companies').upsert(coToRow(id, data)).select().single())));
  if (col === 'accounts') return applyRow('cp_accounts', (await must(SB.from('cp_accounts').upsert(acToRow(id, data)).select().single())));
  if (col === 'layouts') return applyRow('cp_layouts', (await must(SB.from('cp_layouts').upsert({id, data}).select().single())));
  if (col === 'checks') { // backup restore
    const rows = Object.entries(data.checks || {}).map(([no, r]) => ({account_id: data.accountId, company_id: r.companyId, check_no: +no, check_date: r.date, payee: r.payee || '', amount: +r.amount || 0, words: r.words || '', particulars: r.particulars || '', cv_no: r.cvNo || '', ac_payee: !!r.acPayee, entries: r.entries || [], status: r.status || 'Issued', void_reason: r.voidReason || null, printed: r.printed ?? 1}));
    if (rows.length) (await must(SB.from('cp_checks').upsert(rows, {onConflict: 'account_id,check_no', ignoreDuplicates: true}).select())).forEach(r => applyRow('cp_checks', r));
    return;
  }
};
patch = async function (col, id, partial) {
  if (col === 'audit') { for (const e of Object.values(partial.entries || {})) await audit(e.action, e.detail); return; }
  if (col === 'checks') {
    for (const [no, p] of Object.entries(partial.checks || {})) {
      const cur = S.checks[id]?.checks?.[no]; if (!cur) continue;
      const upd = {}; for (const k in p) if (CK_FIELDS[k]) upd[CK_FIELDS[k]] = p[k];
      applyRow('cp_checks', await must(SB.from('cp_checks').update(upd).eq('id', cur._id).select().single()));
    }
    return;
  }
  const cur = S[col][id] || {};
  return put(col, id, deepMerge(clone(cur), clone(partial)));
};
remove = async function (col, id) {
  const t = {companies: 'cp_companies', accounts: 'cp_accounts', layouts: 'cp_layouts'}[col]; if (!t) return;
  const rows = await must(SB.from(t).delete().eq('id', id).select('id'));
  if (!rows.length) throw new Error('Only an administrator can delete this.');
  applyRow(t, {id}, true);
};
audit = async function (action, detail) {
  try { const u = CP_SESSION?.user; applyRow('cp_audit', await must(SB.from('cp_audit').insert({action, detail: detail || '', user_id: u?.id, user_email: u?.email}).select().single())); }
  catch (e) { console.error(e); }
};
writeErr = function (e) { console.error(e); toast(e?.message || 'Could not save.', 'bad'); };

/* ---------- operations that run on the server in one transaction ---------- */
issueCheck = async function () {
  const d = app.draft; const {acct, L} = syncDraftAuto(); if (!acct) return;
  const no = parseInt(d.no, 10); const data = writeData(d, acct);
  if (!no || !data.amount || !data.payee) return;
  const btn = $('#w-issue'); btn.disabled = true;
  let row;
  try {
    row = await must(SB.rpc('cp_issue_check', {p_account_id: acct.id, p_check_no: no, p_check_date: d.date, p_payee: data.payee, p_amount: data.amount,
      p_words: d.words, p_particulars: d.particulars.trim(), p_cv_no: d.cvNo.trim(), p_cv_auto: !!d.cvAuto, p_ac_payee: !!d.acPayee,
      p_entries: d.entries.filter(x => x.acct || x.dr || x.cr).map(x => ({acct: x.acct, dr: parseAmt(x.dr), cr: parseAmt(x.cr)}))}));
  } catch (e) { writeErr(e); btn.disabled = false; return; }
  applyRow('cp_checks', row);
  await refreshRows();
  app.last = {accountId: acct.id, no};
  const alsoV = d.alsoVoucher;
  app.draft = newDraft(acct.id); app.draft.alsoVoucher = alsoV; app.draft.date = d.date;
  fillWriteInputs(); updateWrite(true);
  toast(`Check ${padNo(acct, no)} saved to the register.`);
  const rec = ckFromRow(row); const full = {...rec, no, accountId: acct.id, noStr: padNo(acct, no)};
  await saveFile(`Check-${acct.bank}-${full.noStr}.pdf`, checkPdf(L, {...full, acctNo: acct.number}));
  if (alsoV) await saveFile(`Voucher-${rec.cvNo || full.noStr}.pdf`, voucherPdf(full));
};
spoilSubmit = async function (e) {
  e.preventDefault(); const acctId = $('#sp-acct').value, no = parseInt($('#sp-no').value, 10), reason = $('#sp-reason').value.trim(); const a = S.accounts[acctId];
  if (!a || !no || !reason) { toast('Choose the account, check number and a reason.', 'warn'); return; }
  try { applyRow('cp_checks', await must(SB.rpc('cp_record_spoiled', {p_account_id: acctId, p_check_no: no, p_reason: reason}))); await refreshRows(); toast(`Leaf ${padNo(a, no)} recorded as voided.`); app.spoiledOpen = false; renderRegister(); }
  catch (err) { writeErr(err); }
};
canDelete = function () { return CP_ROLE === 'admin'; };
deleteCheck = async function (acctId, no, reason) {
  const r = S.checks[bucketId(acctId, no)]?.checks?.[no]; if (!r) return null;
  await must(SB.rpc('cp_delete_check', {p_id: r._id, p_reason: reason}));
  applyRow('cp_checks', {id: r._id}, true); await refreshRows(); return r;
};
async function refreshRows() {
  const [cos, acs, au] = await Promise.all([must(SB.from('cp_companies').select('*')), must(SB.from('cp_accounts').select('*')), must(SB.from('cp_audit').select('*').order('at', {ascending: false}).limit(20))]);
  cos.forEach(r => applyRow('cp_companies', r)); acs.forEach(r => applyRow('cp_accounts', r)); au.forEach(r => applyRow('cp_audit', r));
  CP_PAYEES = await must(SB.from('cp_payees').select('*').order('name').limit(5000)); scheduleRender();
}

/* ---------- loading & live updates ---------- */
async function loadAll() {
  const all = async (t, order) => { let out = [], from = 0; for (;;) { const rows = await must(SB.from(t).select('*').order(order).range(from, from + 999)); out = out.concat(rows); if (rows.length < 1000) return out; from += 1000; } };
  const [cos, acs, lays, cks, au, users, pays] = await Promise.all([all('cp_companies', 'id'), all('cp_accounts', 'id'), all('cp_layouts', 'id'), all('cp_checks', 'id'),
    must(SB.from('cp_audit').select('*').order('at', {ascending: false}).limit(300)), must(SB.from('cp_allowed_users').select('*').order('email')), all('cp_payees', 'name')]);
  S = {companies: {}, accounts: {}, layouts: {}, checks: {}, audit: {}};
  cos.forEach(r => S.companies[r.id] = coFromRow(r)); acs.forEach(r => S.accounts[r.id] = acFromRow(r)); lays.forEach(r => S.layouts[r.id] = r.data);
  cks.forEach(r => applyRow('cp_checks', r)); au.forEach(r => applyRow('cp_audit', r)); CP_USERS = users; CP_PAYEES = pays;
  if (CP_CHANNEL) SB.removeChannel(CP_CHANNEL);
  CP_CHANNEL = SB.channel('cp-live');
  for (const t of ['cp_companies', 'cp_accounts', 'cp_layouts', 'cp_checks', 'cp_audit', 'cp_allowed_users', 'cp_payees'])
    CP_CHANNEL.on('postgres_changes', {event: '*', schema: 'public', table: t}, p => applyRow(t, p.eventType === 'DELETE' ? p.old : p.new, p.eventType === 'DELETE'));
  CP_CHANNEL.subscribe();
}

/* ---------- sign-in screen ---------- */
function gate(html) {
  let g = $('#cp-gate');
  if (!g) { g = document.createElement('div'); g.id = 'cp-gate'; document.body.insertBefore(g, document.getElementById('cp-credit')); }
  g.hidden = !html; g.innerHTML = html || ''; $('.app').hidden = !!html;
}
const brandHtml = `<div class="brand" style="margin:0 0 6px"><svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true"><rect x="1" y="7" width="32" height="20" rx="3" fill="var(--accent)"/><path d="M5 20h11M5 23h7" stroke="var(--accent-ink)" stroke-width="1.6" stroke-linecap="round"/><rect x="21" y="11" width="8" height="5" rx="1" fill="none" stroke="var(--accent-ink)" stroke-width="1.4"/></svg><div><h1>Check Printer</h1><small>Meatplus group of companies</small></div></div>`;
function showLogin(msg, kind = 'bad') {
  gate(`<form class="card form cp-login" id="cp-login">${brandHtml}
    <p class="muted" style="margin:0">Sign in with your company account. Access is by invitation.</p>
    ${msg ? `<div class="msg ${kind}">${esc(msg)}</div>` : ''}
    <label class="f">Email<input id="cp-email" type="email" autocomplete="username" required></label>
    <label class="f">Password<input id="cp-pass" type="password" autocomplete="current-password" required></label>
    <div class="actions"><button class="btn primary" id="cp-in">Sign in</button><button type="button" class="btn" id="cp-reset">Forgot password</button><button type="button" class="btn" id="cp-signup">Create account</button></div>
  </form>`);
  const email = () => $('#cp-email').value.trim().toLowerCase(), pass = () => $('#cp-pass').value;
  $('#cp-login').addEventListener('submit', async e => { e.preventDefault(); $('#cp-in').disabled = true; const {error} = await SB.auth.signInWithPassword({email: email(), password: pass()}); if (error) showLogin(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message); });
  $('#cp-reset').addEventListener('click', async () => { if (!email()) { $('#cp-email').focus(); return; } const {error} = await SB.auth.resetPasswordForEmail(email(), {redirectTo: location.origin + location.pathname}); showLogin(error ? error.message : 'Check your email for a link to set a new password.', error ? 'bad' : 'good'); });
  $('#cp-signup').addEventListener('click', async () => { if (!email() || pass().length < 8) { showLogin('Enter your email and a password of at least 8 characters, then press Create account.', 'warn'); return; } const {data, error} = await SB.auth.signUp({email: email(), password: pass(), options: {emailRedirectTo: location.origin + location.pathname}}); if (error) showLogin(error.message); else if (!data.session) showLogin('Account created. Open the confirmation email, then sign in here.', 'good'); });
}
function showNewPassword() {
  gate(`<form class="card form cp-login" id="cp-np">${brandHtml}<h2>Set a new password</h2><label class="f">New password<input id="cp-np1" type="password" autocomplete="new-password" minlength="8" required></label><div class="actions"><button class="btn primary">Save password</button></div></form>`);
  $('#cp-np').addEventListener('submit', async e => { e.preventDefault(); const {error} = await SB.auth.updateUser({password: $('#cp-np1').value}); if (error) toast(error.message, 'bad'); else { toast('Password updated.'); start(); } });
}
function showNoAccess(email) {
  gate(`<div class="card form cp-login">${brandHtml}<div class="msg warn"><b>${esc(email)}</b> is not on the Check Printer user list. Ask the administrator to add you, then reload this page.</div><div class="actions"><button class="btn" id="cp-out2">Sign out</button></div></div>`);
  $('#cp-out2').addEventListener('click', () => SB.auth.signOut());
}

/* ---------- user management (admins) ---------- */
const _renderCompanies = renderCompanies;
renderCompanies = function (force) {
  _renderCompanies(force);
  const host = $('#tab-companies .split > .form'); if (!host || $('#cp-users')) return;
  const isAdmin = CP_ROLE === 'admin';
  host.insertAdjacentHTML('beforeend', `<div class="card form" id="cp-users"><div class="sec-head"><h2>Users</h2><span class="hint">${isAdmin ? 'Only people listed here can sign in' : 'Ask an administrator to change this list'}</span></div>
    <div class="table-wrap" style="border:0"><table class="t"><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>
    ${CP_USERS.slice().sort((a, b) => a.email.localeCompare(b.email)).map(u => `<tr><td>${esc(u.email)}${u.full_name ? `<div class="hint">${esc(u.full_name)}</div>` : ''}${u.active ? '' : ' <span class="st st-Voided">disabled</span>'}</td><td>${u.role === 'admin' ? 'Administrator' : 'User'}</td><td>${isAdmin && u.email !== CP_SESSION?.user?.email ? `<div class="rowacts"><button class="btn sm" data-uact="toggle" data-u="${esc(u.email)}">${u.active ? 'Disable' : 'Enable'}</button><button class="btn sm danger" data-uact="del" data-u="${esc(u.email)}">Remove</button></div>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
    ${isAdmin ? `<form class="row" id="cp-uadd"><label class="f">Email<input id="cp-uemail" type="email" required placeholder="name@meatplus.ph"></label><label class="f">Name<input id="cp-uname"></label><label class="f">Role<select id="cp-urole"><option value="user">User</option><option value="admin">Administrator</option></select></label><div style="align-self:end"><button class="btn primary">Add user</button></div></form>
    <p class="hint" style="margin:0">New people sign in with their existing company account for the Meatplus apps, or press Create account on the sign-in page.</p>` : ''}</div>`);
  if (!isAdmin) return;
  $('#cp-uadd').addEventListener('submit', async e => { e.preventDefault(); try { const row = await must(SB.from('cp_allowed_users').insert({email: $('#cp-uemail').value.trim().toLowerCase(), full_name: $('#cp-uname').value.trim(), role: $('#cp-urole').value}).select().single()); applyRow('cp_allowed_users', row); audit('Added user', row.email + ' (' + row.role + ')'); toast('User added.'); } catch (err) { writeErr(err); } });
  $('#cp-users').addEventListener('click', async e => {
    const b = e.target.closest('[data-uact]'); if (!b) return; const email = b.dataset.u; const u = CP_USERS.find(x => x.email === email); if (!u) return;
    try {
      if (b.dataset.uact === 'toggle') { applyRow('cp_allowed_users', await must(SB.from('cp_allowed_users').update({active: !u.active}).eq('email', email).select().single())); audit(u.active ? 'Disabled user' : 'Enabled user', email); }
      else { await must(SB.from('cp_allowed_users').delete().eq('email', email)); applyRow('cp_allowed_users', u, true); audit('Removed user', email); }
    } catch (err) { writeErr(err); }
  });
};

/* ---------- payees: own tab, manual add/edit, and auto-save when a check is issued ---------- */
const payKey = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const findPayee = name => { const k = payKey(name); return k ? CP_PAYEES.find(p => payKey(p.name) === k) : null; };
async function addPayee(v) {
  const row = {name: String(v.name || '').trim().replace(/\s+/g, ' '), tin: (v.tin || '').trim() || null};
  if (!row.name) throw new Error('Enter the payee name.');
  if (findPayee(row.name)) { const e = new Error('That payee is already saved.'); e.code = '23505'; throw e; }
  try { const r = await must(SB.from('cp_payees').insert(row).select().single()); applyRow('cp_payees', r); audit('Added payee', row.name); return r; }
  catch (err) { if (err.code === '23505') err.message = 'That payee is already saved.'; throw err; }
}
// Tab button + panel
if (!document.querySelector('.tabs [data-tab="payees"]')) {
  document.querySelector('.tabs [data-tab="register"]').insertAdjacentHTML('afterend', '<button role="tab" data-tab="payees">Payees</button>');
  document.querySelector('#tab-register').insertAdjacentHTML('afterend', '<section id="tab-payees" data-panel="payees" hidden></section>');
  document.querySelector('.tabs [data-tab="payees"]').addEventListener('click', () => { app.tab = 'payees'; try { history.replaceState(null, '', '#payees'); } catch {} renderAll(true); });
  if (location.hash === '#payees') app.tab = 'payees';
}
document.head.insertAdjacentHTML('beforeend', `<style id="cp-pay-css">
#cp-pmanage{margin-left:auto;display:inline-flex;align-items:center;gap:4px;padding:3px 10px;border-radius:999px;color:var(--accent);font-weight:600;text-decoration:none;cursor:pointer;border:1px solid transparent;transition:background .15s,border-color .15s,color .15s}
#cp-pmanage span{transition:transform .15s}
#cp-pmanage:hover{background:var(--accent-soft);border-color:var(--accent);text-decoration:underline;text-underline-offset:2px}
#cp-pmanage:hover span{transform:translateX(3px)}
#cp-pmanage:focus-visible{outline:2px solid var(--focus,var(--accent));outline-offset:2px}
</style>`);
/* ---------- programmer credit (shown on the sign-in screen and in the app) ---------- */
if (!document.getElementById('cp-credit')) {
  document.head.insertAdjacentHTML('beforeend', '<meta name="author" content="Nomer Sta Ana"><style>#cp-credit{text-align:center;font-size:12px;color:var(--muted);padding:18px 16px 26px;margin-top:24px;border-top:1px solid var(--line)}#cp-credit b{color:var(--ink);font-weight:600}</style>');
  document.body.insertAdjacentHTML('beforeend', '<footer id="cp-credit">System Developed By: <b>Nomer Sta Ana</b></footer>');
  document.querySelector('.app .brand small')?.insertAdjacentHTML('afterend', '<small id="cp-dev">System Developed By: <b style="color:var(--ink);font-weight:600">Nomer Sta Ana</b></small>');
}
const _renderAll = renderAll;
renderAll = function (force) {
  _renderAll(force);
  if (app.tab === 'payees') renderPayees(force);
  const dl = $('#payees'); if (dl) dl.innerHTML = CP_PAYEES.slice().sort((a, b) => (b.use_count - a.use_count) || a.name.localeCompare(b.name)).slice(0, 2000).map(p => `<option value="${esc(p.name)}">${p.use_count ? 'used ' + p.use_count + '×' : 'saved'}</option>`).join('');
  const pi = $('#w-payee'); if (!pi) return;
  pi.placeholder = 'Type a name, or choose a saved payee';
  if (!$('#cp-psave')) {
    pi.closest('.clr-wrap').insertAdjacentHTML('afterend', `<span id="cp-pline" class="hint" style="display:flex;gap:8px;align-items:center;min-height:26px"><span id="cp-pstat"></span><button type="button" class="btn sm" id="cp-psave" style="display:none">+ Save to payees</button><a id="cp-pmanage" href="#payees" title="Open the Payees tab to add, edit or remove payees">Manage payees <span aria-hidden="true">→</span></a></span>`);
    pi.addEventListener('input', payeeHint);
    $('#cp-psave').addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation(); const b = e.currentTarget; b.disabled = true;
      try { await addPayee({name: $('#w-payee').value}); toast('Payee saved. It will appear in the Payee selection.'); } catch (err) { toast(err.message, 'warn'); }
      b.disabled = false; payeeHint();
    });
    $('#cp-pmanage').addEventListener('click', e => { e.preventDefault(); go('payees'); });
  }
  payeeHint();
};
function payeeHint() {
  const v = $('#w-payee')?.value || '', s = $('#cp-psave'), st = $('#cp-pstat'); if (!s) return;
  const p = findPayee(v);
  s.style.display = (!v.trim() || p) ? 'none' : '';
  st.textContent = p ? '✓ Saved payee' + (p.tin ? ' · TIN ' + p.tin : '') : (v.trim() ? 'New payee' : `${CP_PAYEES.length} saved payee${CP_PAYEES.length === 1 ? '' : 's'}`);
}

let cpPayQ = '', cpPayDel = null, cpPayEdit = null;
function payeeRows() {
  const q = cpPayQ.trim().toLowerCase(), isAdmin = CP_ROLE === 'admin';
  const list = CP_PAYEES.filter(p => !q || [p.name, p.tin].some(x => (x || '').toLowerCase().includes(q))).sort((a, b) => a.name.localeCompare(b.name));
  return list.slice(0, 500).map(p => `<tr><td><b>${esc(p.name)}</b></td><td class="mono">${esc(p.tin || '')}</td><td class="r mono">${p.use_count}</td><td class="mono">${esc(p.last_used || '—')}</td>
    <td style="white-space:nowrap"><button class="btn sm" data-puse="${p.id}" title="Start a check to this payee">Use</button> <button class="btn sm" data-pedit="${p.id}">Edit</button> ${isAdmin ? (cpPayDel === p.id ? `<button class="btn sm danger" data-pdel-ok="${p.id}">Confirm remove</button>` : `<button class="btn sm" data-pdel="${p.id}">Remove</button>`) : ''}</td></tr>`).join('')
    || `<tr><td colspan="5" class="empty">${CP_PAYEES.length ? 'No payee matches.' : 'No payees yet. Add one on the left, or issue a check and its payee is saved automatically.'}</td></tr>`;
}
function renderPayees(force) {
  const el = $('#tab-payees'); if (!el) return;
  if ($('#cp-payees') && !force) { $('#cp-plist').innerHTML = payeeRows(); $('#cp-pcount').textContent = CP_PAYEES.length; return; }
  const ed = cpPayEdit ? CP_PAYEES.find(p => p.id === cpPayEdit) : null; if (!ed) cpPayEdit = null;
  el.innerHTML = `<div class="split" id="cp-payees">
    <form id="cp-padd" class="card form" autocomplete="off"><div class="sec-head"><h2>${ed ? 'Edit payee' : 'Add payee'}</h2></div>
      <label class="f">Payee name (as printed on the check)<input id="cp-pname" required maxlength="120" value="${esc(ed?.name || '')}" placeholder="e.g. ABC Meat Supply Inc."></label>
      <label class="f">TIN (optional)<input id="cp-ptin" maxlength="30" value="${esc(ed?.tin || '')}" placeholder="000-000-000-000"></label>
      <div class="actions"><button class="btn primary" type="submit">${ed ? 'Save changes' : 'Add payee'}</button>${ed ? '<button class="btn" type="button" id="cp-pcancel">Cancel</button>' : ''}</div>
      <p class="hint" style="margin:0">Payees are also saved automatically each time a check is issued. Saved payees appear as choices in the Payee field of Write check.</p>
    </form>
    <div><div class="sec-head" style="margin-bottom:10px"><h2>Payees</h2><span class="hint"><span id="cp-pcount">${CP_PAYEES.length}</span> saved</span></div>
      <label class="f" style="margin-bottom:10px">Search<input id="cp-pq" placeholder="Name or TIN" value="${esc(cpPayQ)}"></label>
      <div class="table-wrap"><table class="t"><thead><tr><th>Payee</th><th>TIN</th><th class="r">Checks</th><th>Last used</th><th></th></tr></thead><tbody id="cp-plist">${payeeRows()}</tbody></table></div></div></div>`;
  $('#cp-pq').addEventListener('input', e => { cpPayQ = e.target.value; $('#cp-plist').innerHTML = payeeRows(); });
  $('#cp-pcancel')?.addEventListener('click', () => { cpPayEdit = null; renderPayees(true); });
  $('#cp-padd').addEventListener('submit', async e => {
    e.preventDefault(); const btn = e.submitter; if (btn) btn.disabled = true;
    const v = {name: $('#cp-pname').value, tin: $('#cp-ptin').value};
    try {
      if (ed) {
        const name = v.name.trim().replace(/\s+/g, ' '); if (!name) throw new Error('Enter the payee name.');
        const dup = findPayee(name); if (dup && dup.id !== ed.id) throw new Error('Another saved payee already has that name.');
        const r = await must(SB.from('cp_payees').update({name, tin: v.tin.trim() || null}).eq('id', ed.id).select().single());
        applyRow('cp_payees', r); audit('Updated payee', name); toast('Payee updated.'); cpPayEdit = null;
      } else { await addPayee(v); toast('Payee added.'); }
      renderPayees(true); $('#cp-pname')?.focus();
    } catch (err) { toast(err.code === '23505' ? 'Another saved payee already has that name.' : err.message, 'warn'); if (btn) btn.disabled = false; }
  });
  $('#cp-payees').addEventListener('click', async e => {
    const u = e.target.closest('[data-puse]');
    if (u) { const p = CP_PAYEES.find(x => x.id === u.dataset.puse); if (p) { app.draft.payee = p.name; go('write'); toast('Payee filled in: ' + p.name); } return; }
    const ed1 = e.target.closest('[data-pedit]'); if (ed1) { cpPayEdit = ed1.dataset.pedit; renderPayees(true); window.scrollTo({top: 0}); $('#cp-pname').focus(); return; }
    const d1 = e.target.closest('[data-pdel]'); if (d1) { cpPayDel = d1.dataset.pdel; $('#cp-plist').innerHTML = payeeRows(); return; }
    const d2 = e.target.closest('[data-pdel-ok]'); if (!d2) return;
    const id = d2.dataset.pdelOk, p = CP_PAYEES.find(x => x.id === id);
    try { const rows = await must(SB.from('cp_payees').delete().eq('id', id).select('id')); if (!rows.length) throw new Error('Only an administrator can remove payees.'); applyRow('cp_payees', {id}, true); audit('Removed payee', p?.name || ''); toast('Payee removed.'); }
    catch (err) { writeErr(err); }
    cpPayDel = null; if (cpPayEdit === id) cpPayEdit = null; if ($('#cp-plist')) $('#cp-plist').innerHTML = payeeRows();
  });
}

/* ---------- header: who is signed in ---------- */
const _renderTop = renderTop;
renderTop = function () {
  _renderTop();
  const chip = $('#store-chip'); chip.className = 'chip cloud'; chip.textContent = 'Online'; chip.title = 'Saved to the Meatplus Supabase database. Everyone on the user list sees changes live.';
  if (!$('#cp-me')) chip.insertAdjacentHTML('afterend', `<span id="cp-me" class="hint"></span><button class="btn sm" id="cp-out">Sign out</button>`), $('#cp-out').addEventListener('click', () => SB.auth.signOut());
  $('#cp-me').textContent = CP_SESSION?.user?.email || '';
};

/* ---------- start ---------- */
let CP_STARTED = false, CP_STARTING = null;
function start() { if (!CP_STARTING) CP_STARTING = startInner().finally(() => { CP_STARTING = null; }); return CP_STARTING; }
async function startInner() {
  const {data: {session}} = await SB.auth.getSession(); CP_SESSION = session;
  if (!session) { CP_STARTED = false; showLogin(); return; }
  gate('<div class="card cp-login"><p class="muted">Loading records…</p></div>');
  const email = session.user.email.toLowerCase();
  const {data: me, error} = await SB.from('cp_allowed_users').select('*').eq('email', email).maybeSingle();
  if (error || !me || !me.active) { showNoAccess(email); return; }
  CP_ROLE = me.role;
  try { await loadAll(); } catch (e) { gate(`<div class="card form cp-login">${brandHtml}<div class="msg bad">Could not load records: ${esc(e.message)}</div><div class="actions"><button class="btn" onclick="location.reload()">Try again</button></div></div>`); return; }
  DB = SB; CP_STARTED = true;
  for (const k in mounted) delete mounted[k];
  gate(''); renderAll(true);
}
SB.auth.onAuthStateChange((event, session) => {
  CP_SESSION = session;
  if (event === 'PASSWORD_RECOVERY') { showNewPassword(); return; }
  if (event === 'SIGNED_OUT') { if (CP_CHANNEL) SB.removeChannel(CP_CHANNEL); CP_CHANNEL = null; CP_STARTED = false; S = {companies: {}, accounts: {}, layouts: {}, checks: {}, audit: {}}; showLogin('You are signed out.', 'info'); return; }
  if (event === 'SIGNED_IN' && !CP_STARTED) setTimeout(start, 0);
});
start();
