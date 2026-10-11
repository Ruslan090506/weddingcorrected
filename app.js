const Engine = (() => {
const EMPLOYEES = [
  { id: 'svetlana', name: 'Svetlana de Monte Carlo', role: 'manager' },
  { id: 'richard', name: 'Richard “Call Me Dick” Darling', role: 'sales' },
  { id: 'anastasia', name: 'Anastasia Ferrari', role: 'sales' },
  { id: 'jean', name: 'Jean-Claude Bērziņš', role: 'sales' },
  { id: 'kevin', name: 'Kevin von Whatever', role: 'expenses' }
];
const SELLERS = ['richard', 'anastasia', 'jean'];
const PROJECTS = { A: 'Respectable Relatives', B: 'Drunk University Friends', overhead: 'Company overhead' };
class RuleError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const euro = cents => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
const employee = id => EMPLOYEES.find(e => e.id === id);
function requireRole(actor, role) { if (employee(actor)?.role !== role) throw new RuleError('This demonstration role cannot perform that action.', 403); }
function initialState() {
  return { schema: 1, employees: EMPLOYEES, revision: 0, transactions: [], telegramUsers: {}, telegramUpdates: [], jobs: [], sync: { revision: 0, status: 'synced', error: null, at: null }, lease: null };
}
function text(v, name, max = 500) {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max) throw new RuleError(`${name} is required (maximum ${max} characters).`);
  return v.trim();
}
function scaled(v, name) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new RuleError(`${name} must be a number with at most two decimal places.`);
  const [a, b = ''] = s.split('.');
  const n = Number(a) * 100 + Number(b.padEnd(2, '0'));
  if (!Number.isSafeInteger(n)) throw new RuleError(`${name} is too large.`);
  return n;
}
function money(v) { const n = scaled(v, 'Amount'); if (n <= 0 || n > 999999999) throw new RuleError('Amount must be between €0.01 and €9,999,999.99.'); return n; }
function split(v) {
  if (!Array.isArray(v) || v.length !== 3) throw new RuleError('Supply shares for Richard, Anastasia and Jean-Claude.');
  const s = v.map(x => scaled(x, 'Share'));
  if (s.some(x => x > 10000) || s.reduce((a, b) => a + b, 0) !== 10000) throw new RuleError('Commission shares must be 0–100% and total exactly 100%.');
  return s;
}
function commission(cents, shares) {
  const pool = Number((BigInt(cents) + 5n) / 10n);
  const earned = shares.map(s => Number((BigInt(pool) * BigInt(s) + 5000n) / 10000n));
  const largest = shares.indexOf(Math.max(...shares));
  earned[largest] += pool - earned.reduce((a, b) => a + b, 0);
  return { pool, earned };
}
function allocation(v) { if (!Object.hasOwn(PROJECTS, v)) throw new RuleError('Allocation must be A, B or Company overhead.'); return v; }
function linkedChat(state, actor) { return Object.values(state.telegramUsers).find(u => u.employeeId === actor)?.chatId ?? null; }
function queueMessage(state, id, reference, chatId, message, now) {
  if (state.jobs.some(j => j.id === id)) return;
  state.jobs.push({ id, reference, chatId: chatId ? String(chatId) : null, text: message, status: chatId ? 'pending' : 'no_recipient', error: null, attempts: 0, createdAt: now, sentAt: null });
}
const shareText = bps => `${bps / 100}%`;
function confirmation(t) { return `${t.reference} recorded. ${euro(t.amount)}. ${PROJECTS[t.type === 'sale' ? t.project : t.proposedAllocation]}. Status: ${t.status.replaceAll('_', ' ')}.`; }
function applyCommand(inputState, actor, command, now = new Date().toISOString(), origin = { kind: 'website' }) {
  const state = structuredClone(inputState);
  if (!employee(actor)) throw new RuleError('Select a demonstration role first.', 401);
  if (command.action === 'link') {
    requireRole(actor, 'manager');
    const userId = text(String(command.userId ?? ''), 'Telegram user ID', 24);
    if (!/^\d+$/.test(userId) || !state.telegramUsers[userId]) throw new RuleError('This Telegram user must start the bot in a private chat first.');
    if (command.employeeId !== null && !employee(command.employeeId)) throw new RuleError('Choose a valid employee.');
    const current = state.telegramUsers[userId].employeeId ?? null;
    if (Object.hasOwn(command, 'expectedEmployeeId') && command.expectedEmployeeId !== current) throw new RuleError('This binding changed since you loaded it. Refresh records and check it before switching.', 409);
    if (command.employeeId && Object.entries(state.telegramUsers).some(([id, u]) => id !== userId && u.employeeId === command.employeeId)) throw new RuleError('This employee is already linked to another Telegram account. No binding was changed. Choose an available employee; do not unlink somebody else.', 409);
    state.telegramUsers[userId].employeeId = command.employeeId;
    return state;
  }
  if (command.action === 'submit') {
    const p = command.transaction ?? {};
    if (!['sale', 'expense'].includes(p.type)) throw new RuleError('Choose sale or expense.');
    requireRole(actor, p.type === 'sale' ? 'sales' : 'expenses');
    const reference = text(p.reference, 'Reference', 40).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(reference)) throw new RuleError('Reference may contain letters, numbers, hyphens and underscores.');
    if (state.transactions.some(t => t.reference === reference)) throw new RuleError(`Reference ${reference} already exists. Open the saved record instead.`, 409);
    const t = { reference, type: p.type, submitter: actor, submittedAt: now, description: text(p.description, 'Description'), amount: money(p.amount), origin: origin.kind, originalChatId: origin.kind === 'telegram' ? String(origin.chatId) : linkedChat(state, actor), telegramUpdateId: origin.updateId ?? null, approvedAt: null, approvedBy: null, approvedSplit: null, commission: { pool: 0, earned: [0, 0, 0] }, finalAllocation: null };
    if (p.type === 'sale') {
      if (!['A', 'B'].includes(p.project)) throw new RuleError('A sale must belong to project A or B.');
      Object.assign(t, { customer: text(p.customer, 'Customer', 150), project: p.project, proposedSplit: split(p.split), status: 'pending_approval' });
    } else {
      if (!['Materials', 'Travel', 'Other'].includes(p.category)) throw new RuleError('Category must be Materials, Travel or Other.');
      Object.assign(t, { category: p.category, proposedAllocation: allocation(p.allocation), status: p.allocation === 'overhead' ? 'allocated' : 'awaiting_allocation', finalAllocation: p.allocation === 'overhead' ? 'overhead' : null });
    }
    state.revision += 1; t.revision = state.revision; state.transactions.push(t);
    queueMessage(state, `confirmation:${reference}`, reference, t.originalChatId, confirmation(t), now);
    state.sync.status = 'pending'; state.sync.error = null;
    return state;
  }
  if (command.action === 'approve') {
    requireRole(actor, 'manager');
    const t = state.transactions.find(t => t.reference === command.reference);
    if (!t) throw new RuleError('Transaction not found.', 404);
    if (['approved', 'allocated'].includes(t.status)) return state;
    let message;
    if (t.type === 'sale') {
      t.approvedSplit = split(command.split); t.commission = commission(t.amount, t.approvedSplit); t.status = 'approved';
      const changed = t.approvedSplit.some((n, i) => n !== t.proposedSplit[i]);
      message = `Sale ${t.reference} approved — commission split ${changed ? 'changed' : 'unchanged'}. Sale ${euro(t.amount)}; total commission ${euro(t.commission.pool)}.\n` + ['Richard', 'Anastasia', 'Jean-Claude'].map((name, i) => `${name}: ${shareText(t.proposedSplit[i])} → ${shareText(t.approvedSplit[i])} (${euro(t.commission.earned[i])}).`).join('\n');
    } else {
      t.finalAllocation = allocation(command.allocation); t.status = 'allocated';
      message = `Expense ${t.reference} — allocation ${t.finalAllocation === t.proposedAllocation ? 'confirmed' : 'changed'}. ${euro(t.amount)}: ${t.description}\nProposed: ${PROJECTS[t.proposedAllocation]}. Approved: ${PROJECTS[t.finalAllocation]}.`;
    }
    t.approvedAt = now; t.approvedBy = actor; state.revision += 1; t.revision = state.revision;
    // Bot submissions always use their immutable originating chat. Website entries can
    // acquire a recipient at decision time, as required by the Test 2 linking sequence.
    const recipient = t.origin === 'telegram' ? t.originalChatId : (linkedChat(state, t.submitter) ?? t.originalChatId);
    queueMessage(state, `decision:${t.reference}`, t.reference, recipient, message, now);
    state.sync.status = 'pending'; state.sync.error = null;
    return state;
  }
  throw new RuleError('Unknown action.');
}
function results(state) {
  const projects = { A: { income: 0, commissions: 0, expenses: 0, result: 0 }, B: { income: 0, commissions: 0, expenses: 0, result: 0 } };
  const earned = { richard: 0, anastasia: 0, jean: 0 };
  let income = 0, commissions = 0, expenses = 0, overhead = 0, awaiting = 0, pendingSales = 0;
  for (const t of state.transactions) {
    if (t.type === 'sale') {
      if (t.status !== 'approved') { pendingSales += t.amount; continue; }
      income += t.amount; commissions += t.commission.pool;
      projects[t.project].income += t.amount; projects[t.project].commissions += t.commission.pool;
      SELLERS.forEach((s, i) => earned[s] += t.commission.earned[i]);
    } else {
      expenses += t.amount;
      if (t.status === 'awaiting_allocation') awaiting += t.amount;
      else if (t.finalAllocation === 'overhead') overhead += t.amount;
      else projects[t.finalAllocation].expenses += t.amount;
    }
  }
  for (const p of Object.values(projects)) p.result = p.income - p.commissions - p.expenses;
  return { projects, earned, income, commissions, expenses, overhead, awaiting, pendingSales, companyResult: income - commissions - expenses };
}
function viewState(state, actor) {
  if (!employee(actor)) throw new RuleError('Select a demonstration role first.', 401);
  const manager = employee(actor).role === 'manager';
  const transactions = state.transactions.filter(t => manager || t.submitter === actor).map(t => {
    const { originalChatId, telegramUpdateId, ...safe } = t;
    return { ...safe, syncStatus: t.revision <= state.sync.revision ? 'synced' : state.sync.status, syncError: t.revision <= state.sync.revision ? null : state.sync.error,
      notifications: state.jobs.filter(j => j.reference === t.reference).map(({ id, status, error, sentAt }) => ({ id, status, error, sentAt })) };
  });
  return { actor: employee(actor), employees: EMPLOYEES, transactions, results: manager ? results(state) : null, sync: manager ? state.sync : null,
    telegramUsers: manager ? Object.entries(state.telegramUsers).map(([id, u]) => ({ userId: id, ...u })) : [],
    ownCommission: SELLERS.includes(actor) ? results(state).earned[actor] : null };
}

return {initialState, applyCommand, viewState, EMPLOYEES, employee};
})();
const $ = id => document.getElementById(id);
const money = c => new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(c / 100);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const project = x => ({ A: 'Respectable Relatives', B: 'Drunk University Friends', overhead: 'Company overhead' })[x] ?? 'Awaiting allocation';
const status = s => ({ pending_approval: 'Pending approval', awaiting_allocation: 'Awaiting allocation', approved: 'Approved', allocated: 'Allocated', synced: 'Synced', pending: 'Sync pending', failed: 'Sync failed' })[s] ?? s;
let config, data;
function flash(text, kind = 'success') { $('message').textContent = text; $('message').className = kind; $('message').hidden = false; }
const STORAGE_KEY = 'friends-included-standalone-v1';
let activeEmployee = null;
function readLedger() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return Engine.initialState();
  try { const s = JSON.parse(raw); if (s.schema !== 1 || !Array.isArray(s.transactions)) throw new Error(); return s; }
  catch { throw new Error('Saved browser data cannot be read. It has not been overwritten.'); }
}
function localView() {
  const v = Engine.viewState(readLedger(), activeEmployee);
  v.transactions.forEach(t => { t.syncStatus = 'Saved in this browser'; t.syncError = null; t.notifications = []; });
  return v;
}
async function api(action, payload) {
  if (action === 'config') return { employees: Engine.EMPLOYEES, studentName: 'Standalone finance coursework', local: true, accessCodeRequired: false, botUrl: '', sheetsUrl: '', githubUrl: '' };
  if (action === 'session') {
    if (!Engine.employee(payload.actor)) throw new Error('Choose an employee first.');
    readLedger(); activeEmployee = payload.actor; return {ok:true};
  }
  if (!activeEmployee) throw new Error('Select a demonstration role first.');
  if (action === 'state') return localView();
  if (!['submit','approve'].includes(action)) throw new Error('External connections are disabled in this standalone version.');
  const save = () => {
    const next = Engine.applyCommand(readLedger(), activeEmployee, {...payload, action}, new Date().toISOString(), {kind:'browser'});
    next.jobs = []; // This standalone version does not send or queue external messages.
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return localView();
  };
  if (navigator.locks) return navigator.locks.request(STORAGE_KEY, save);
  return save();
}
async function task(button, operation) {
  button.disabled = true;
  try { await operation(); } catch (e) { flash(e.message, 'error'); } finally { button.disabled = false; }
}
const badge = (text, good = false, bad = false) => `<span class="status ${good ? 'ok' : ''} ${bad ? 'error' : ''}">${esc(text)}</span>`;
const options = (list, selected) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === selected ? 'selected' : ''}>${esc(l)}</option>`).join('');
const allocOptions = selected => options([['A', 'A · Respectable Relatives'], ['B', 'B · Drunk University Friends'], ['overhead', 'Company overhead']], selected);
function splitFields(values = [100, 0, 0], suffix = '') { return `<div class="split-inputs">${['Richard', 'Anastasia', 'Jean-Claude'].map((n, i) => `<div><label for="share-${suffix}-${i}">${n} %</label><input id="share-${suffix}-${i}" name="share${i}" type="number" min="0" max="100" step="0.01" required value="${values[i]}"></div>`).join('')}</div>`; }
function renderDashboard(r) {
  $('dashboard').innerHTML = `<div class="metrics"><div class="metric main"><p>COMPANY RESULT</p><strong>${money(r.companyResult)}</strong><small>All recorded expenses included</small></div><div class="metric"><p>APPROVED INCOME</p><strong>${money(r.income)}</strong><small>${money(r.pendingSales)} sales pending</small></div><div class="metric"><p>COMMISSION EARNED</p><strong>${money(r.commissions)}</strong><small>10% of approved sales</small></div><div class="metric"><p>PAID EXPENSES</p><strong>${money(r.expenses)}</strong><small>Includes unallocated expenses</small></div></div><div class="project-grid">${['A', 'B'].map(key => { const p = r.projects[key]; return `<article class="project ${key === 'B' ? 'b' : ''}"><span class="project-tag">PROJECT ${key}</span><h3>${project(key)}</h3><div class="breakdown"><div><span>Approved income</span><strong>${money(p.income)}</strong></div><div><span>Commissions</span><strong>${money(p.commissions)}</strong></div><div><span>Allocated expenses</span><strong>${money(p.expenses)}</strong></div></div><div class="project-total"><span>Project result</span><strong>${money(p.result)}</strong></div></article>`; }).join('')}</div><div class="reconciliation"><b>Company reconciliation</b><br><span class="reconcile-eq">${money(r.projects.A.result)} + ${money(r.projects.B.result)} − ${money(r.overhead)} company overhead − ${money(r.awaiting)} awaiting allocation = <b>${money(r.companyResult)}</b></span></div><div class="commission-line"><span>Richard <strong>${money(r.earned.richard)}</strong></span><span>Anastasia <strong>${money(r.earned.anastasia)}</strong></span><span>Jean-Claude <strong>${money(r.earned.jean)}</strong></span></div>`;
}
function renderForm() {
  const sale = data.actor.role === 'sales';
  $('entry-title').textContent = sale ? 'Record a paid sale' : 'Record a paid expense';
  $('entry-form').innerHTML = `<div class="fields"><div><label for="reference">Unique reference</label><input id="reference" name="reference" required maxlength="40" placeholder="${sale ? 'S01' : 'E01'}" pattern="[A-Za-z0-9][A-Za-z0-9_-]*"></div><div><label for="amount">Amount EUR</label><input id="amount" name="amount" required type="number" min="0.01" max="9999999.99" step="0.01" placeholder="0.00"></div>${sale ? '<div><label for="project">Project</label><select id="project" name="project"><option value="A">A · Respectable Relatives</option><option value="B">B · Drunk University Friends</option></select></div><div><label for="customer">Customer</label><input id="customer" name="customer" required maxlength="150"></div>' : '<div><label for="category">Category</label><select id="category" name="category"><option>Materials</option><option>Travel</option><option>Other</option></select></div><div><label for="allocation">Proposed allocation</label><select id="allocation" name="allocation">' + allocOptions('A') + '</select></div>'}<div class="wide"><label for="description">Description</label><input id="description" name="description" required maxlength="500"></div>${sale ? `<div class="full split-box"><p><b>Divide the 10% commission pool.</b> Shares must total 100%.</p>${splitFields()}</div>` : ''}</div><div class="form-end"><button type="submit" class="primary">Save ${sale ? 'sale' : 'expense'}</button><span>Submitted as ${esc(data.actor.name)}. ${sale ? 'Income counts after approval.' : 'Company result changes immediately.'}</span></div>`;
}
function renderApprovals() {
  const pending = data.transactions.filter(t => ['pending_approval', 'awaiting_allocation'].includes(t.status));
  $('pending-count').textContent = `${pending.length} awaiting decision`;
  $('approvals').innerHTML = pending.length ? pending.map(t => `<article class="approval"><div><h3>${esc(t.reference)} · ${money(t.amount)} ${badge(t.type === 'sale' ? 'Sale' : 'Expense')}</h3><p>${esc(t.description)}</p><p class="muted">Submitted by ${esc(config.employees.find(e => e.id === t.submitter).name)} · ${esc(t.origin)}</p><p><b>Original proposal:</b> ${t.type === 'sale' ? project(t.project) + ' · ' + t.proposedSplit.map(n => n / 100 + '%').join(' / ') : project(t.proposedAllocation)}</p>${t.type === 'sale' ? '<p>Commission pool: ' + money(Math.round(t.amount / 10)) + '</p>' : ''}</div><form class="approval-controls" data-reference="${esc(t.reference)}" data-type="${t.type}">${t.type === 'sale' ? splitFields(t.proposedSplit.map(n => n / 100), t.reference) : `<label for="alloc-${esc(t.reference)}">Final allocation</label><select id="alloc-${esc(t.reference)}" name="allocation">${allocOptions(t.proposedAllocation)}</select>`}<button type="submit" class="primary">${t.type === 'sale' ? 'Approve sale & split' : 'Confirm allocation'}</button></form></article>`).join('') : '<p class="empty">No decisions waiting. New submissions will appear here.</p>';
}
function renderRecords() {
  $('records-title').textContent = data.actor.role === 'manager' ? 'All transactions' : 'Your submissions';
  $('records').innerHTML = data.transactions.length ? `<div class="table-wrap"><table><thead><tr><th>Reference / employee</th><th>Description</th><th>Project / allocation</th><th>Amount</th><th>Status</th><th>Storage</th></tr></thead><tbody>${[...data.transactions].reverse().map(t => `<tr><td><b>${esc(t.reference)}</b><small>${esc(config.employees.find(e => e.id === t.submitter).name)}</small><small>${esc(new Date(t.submittedAt).toLocaleString())} · ${esc(t.origin)}</small></td><td>${esc(t.description)}${t.customer ? '<small>Customer: ' + esc(t.customer) + '</small>' : '<small>' + esc(t.category) + '</small>'}${t.type === 'sale' ? `<details><summary>Commission proposal & decision</summary><p>Richard / Anastasia / Jean-Claude<br>Proposed: ${t.proposedSplit.map(n => n / 100 + '%').join(' / ')}<br>Final: ${t.approvedSplit?.map(n => n / 100 + '%').join(' / ') ?? 'Not approved'}<br>Earned: ${t.commission.earned.map(money).join(' / ')}</p></details>` : ''}</td><td>${esc(project(t.type === 'sale' ? t.project : t.finalAllocation))}${t.type === 'expense' ? '<small>Proposed: ' + esc(project(t.proposedAllocation)) + '</small>' : ''}</td><td class="numeric">${money(t.amount)}</td><td>${badge(status(t.status), ['approved', 'allocated'].includes(t.status))}</td><td>${badge(status(t.syncStatus), t.syncStatus === 'synced', t.syncStatus === 'failed')}${t.syncError ? '<small>' + esc(t.syncError) + '</small>' : ''}${t.notifications.map(n => `<small>${esc(n.id.startsWith('decision:') ? 'Decision' : 'Confirmation')}: ${esc(n.status === 'no_recipient' ? 'No Telegram recipient linked' : n.status === 'sent' ? 'Telegram sent' : n.status === 'failed' ? 'Telegram failed — retry in Manager setup' : 'Telegram pending')}${n.error ? ' · ' + esc(n.error) : ''}</small>`).join('')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty">No saved transactions yet. Record one through the website or Telegram.</p>';
}
function renderSetup() {
  const s = data.sync;
  $('sync-summary').innerHTML = `<div class="sync-line">${badge(s.status === 'synced' ? 'Google Sheets up to date' : status(s.status), s.status === 'synced', s.status === 'failed')}<p>${esc(s.error ?? (s.at ? 'Last synchronized ' + new Date(s.at).toLocaleString() : 'The first transaction will trigger synchronization.'))}</p></div>`;
  $('linked-users').innerHTML = data.telegramUsers.length ? data.telegramUsers.map(u => `<p class="linked-person"><b>${esc(u.userId)}</b> → ${esc(config.employees.find(e => e.id === u.employeeId)?.name ?? 'Not linked')}</p>`).join('') : '<p class="empty">No Telegram account has started the bot yet.</p>';
}
function render({ form = false } = {}) {
  $('welcome').hidden = true; $('workspace').hidden = false;
  const manager = data.actor.role === 'manager';
  $('role').value = data.actor.id; $('workspace-title').textContent = manager ? 'Company overview' : data.actor.role === 'sales' ? 'Sales workspace' : 'Expense workspace';
  $('role-caption').textContent = data.actor.name.toUpperCase();
  $('dashboard').hidden = !manager; $('approval-section').hidden = !manager; $('manager-setup').hidden = true; $('entry-section').hidden = manager;
  if (manager) { renderDashboard(data.results); renderApprovals(); }
  else if (form) renderForm();
  renderRecords(); $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
$('switch-role').addEventListener('click', e => task(e.currentTarget, async () => { await api('session', { actor: $('role').value, code: $('code').value }); data = await api('state'); render({ form: true }); flash(`Workspace opened for ${data.actor.name}.`); }));
$('refresh').addEventListener('click', e => task(e.currentTarget, async () => { data = await api('state'); render(); }));
$('entry-form').addEventListener('submit', e => { e.preventDefault(); const form = e.currentTarget, p = Object.fromEntries(new FormData(form)); const sale = data.actor.role === 'sales'; const transaction = { ...p, type: sale ? 'sale' : 'expense' }; if (sale) transaction.split = [p.share0, p.share1, p.share2]; task(form.querySelector('button'), async () => { data = await api('submit', { transaction }); render({ form: true }); flash(`${p.reference.toUpperCase()} saved. Saved in this browser.`); }); });
$('approvals').addEventListener('submit', e => { e.preventDefault(); const form = e.target, p = Object.fromEntries(new FormData(form)); task(form.querySelector('button'), async () => { data = await api('approve', { reference: form.dataset.reference, ...(form.dataset.type === 'sale' ? { split: [p.share0, p.share1, p.share2] } : { allocation: p.allocation }) }); render(); flash(`${form.dataset.reference} decision saved. Saved in this browser.`); }); });
$('link-form').addEventListener('submit', e => { e.preventDefault(); const p = Object.fromEntries(new FormData(e.currentTarget)); task(e.currentTarget.querySelector('button'), async () => { data = await api('link', { userId: p.userId, employeeId: p.employeeId || null, expectedEmployeeId: data.telegramUsers.find(u => u.userId === p.userId)?.employeeId ?? null }); render(); flash('Telegram link saved. Existing bot submissions keep their original chat.'); }); });
$('retry').addEventListener('click', e => task(e.currentTarget, async () => { data = await api('retry', {}); render(); flash('Retry processed. Check each record for any remaining failure or pending notification.'); }));
async function boot() {
  try {
    config = await api('config'); $('student').textContent = config.studentName; $('local-warning').hidden = !config.local;
    $('role').innerHTML += options(config.employees.map(e => [e.id, e.name]));
    $('link-employee').innerHTML = options([['', 'Remove link'], ...config.employees.map(e => [e.id, e.name])]);
    $('code').hidden = $('code-label').hidden = !config.accessCodeRequired;
    const links = [['bot-link', config.botUrl], ['sheets-link', config.sheetsUrl], ['github-link', config.githubUrl]];
    links.forEach(([id, url]) => { if (url) { $(id).href = url; $(id).hidden = false; } });
    const missing = links.filter(([, u]) => !u).map(([id]) => ({ 'bot-link': 'Telegram bot', 'sheets-link': 'Google Sheets ledger', 'github-link': 'source repository' })[id]);
    $('missing-links').textContent = missing.length ? 'Setup incomplete: ' + missing.join(', ') + '. The owner must configure these real project links before live review.' : 'Reviewer: open the bot, send /start, then follow Manager setup below. Sheets access must be Viewer.';
    try { data = await api('state'); render({ form: true }); } catch (e) { if (!/Select a demonstration role|Session expired|Session is invalid/.test(e.message)) flash(e.message, 'error'); }
  } catch (e) { flash(e.message, 'error'); }
}
boot();
