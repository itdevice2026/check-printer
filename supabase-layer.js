/* ===================================================================
   Supabase layer for the online (GitHub Pages) edition.
   Loaded after the core app script; replaces its storage functions.
   =================================================================== */
'use strict';
const CP_CONFIG = window.CP_CONFIG || {};
const SB = window.supabase.createClient(CP_CONFIG.supabaseUrl, CP_CONFIG.supabaseKey, {auth: {persistSession: true, autoRefreshToken: true}});
let CP_SESSION = null, CP_ROLE = null, CP_USERS = [], CP_CHANNEL = null;

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
async function refreshRows() {
  const [cos, acs, au] = await Promise.all([must(SB.from('cp_companies').select('*')), must(SB.from('cp_accounts').select('*')), must(SB.from('cp_audit').select('*').order('at', {ascending: false}).limit(20))]);
  cos.forEach(r => applyRow('cp_companies', r)); acs.forEach(r => applyRow('cp_accounts', r)); au.forEach(r => applyRow('cp_audit', r));
}

/* ---------- loading & live updates ---------- */
async function loadAll() {
  const all = async (t, order) => { let out = [], from = 0; for (;;) { const rows = await must(SB.from(t).select('*').order(order).range(from, from + 999)); out = out.concat(rows); if (rows.length < 1000) return out; from += 1000; } };
  const [cos, acs, lays, cks, au, users] = await Promise.all([all('cp_companies', 'id'), all('cp_accounts', 'id'), all('cp_layouts', 'id'), all('cp_checks', 'id'),
    must(SB.from('cp_audit').select('*').order('at', {ascending: false}).limit(300)), must(SB.from('cp_allowed_users').select('*').order('email'))]);
  S = {companies: {}, accounts: {}, layouts: {}, checks: {}, audit: {}};
  cos.forEach(r => S.companies[r.id] = coFromRow(r)); acs.forEach(r => S.accounts[r.id] = acFromRow(r)); lays.forEach(r => S.layouts[r.id] = r.data);
  cks.forEach(r => applyRow('cp_checks', r)); au.forEach(r => applyRow('cp_audit', r)); CP_USERS = users;
  if (CP_CHANNEL) SB.removeChannel(CP_CHANNEL);
  CP_CHANNEL = SB.channel('cp-live');
  for (const t of ['cp_companies', 'cp_accounts', 'cp_layouts', 'cp_checks', 'cp_audit', 'cp_allowed_users'])
    CP_CHANNEL.on('postgres_changes', {event: '*', schema: 'public', table: t}, p => applyRow(t, p.eventType === 'DELETE' ? p.old : p.new, p.eventType === 'DELETE'));
  CP_CHANNEL.subscribe();
}

/* ---------- sign-in screen ---------- */
function gate(html) {
  let g = $('#cp-gate');
  if (!g) { g = document.createElement('div'); g.id = 'cp-gate'; document.body.appendChild(g); }
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
