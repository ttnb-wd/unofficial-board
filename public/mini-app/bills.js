const telegram = window.Telegram?.WebApp;
const api = window.BOARD_API_ORIGIN ?? '';
const entry = new URLSearchParams(window.location.search).get('view') ?? 'create';
const content = document.querySelector('#bill-content');
const heading = document.querySelector('#bill-title');
const error = document.querySelector('#bill-error');
const notice = document.querySelector('#bill-notice');
const nav = document.querySelector('#bill-navigation');
const stack = [];
const fixtures = new Map();
let session;
let busy = false;
let role = 'debtor';
let bankProofUrl;

const statuses = {
  UNPAID: 'Unpaid', PAY_LATER: 'Pay Later', PENDING_VERIFICATION: 'Pending verification', PAID: 'Paid',
};
const deliveryStatus = {
  QUEUED: 'Announcement queued', SENDING: 'Sending announcement', SENT: 'Announced in the group',
  FAILED: 'Announcement delivery failed', UNKNOWN: 'Announcement delivery could not be verified',
};

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, click, className) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

function message(node, value) {
  node.textContent = value ?? '';
  node.hidden = !value;
}

function amount(value) {
  return `${BigInt(value).toLocaleString('en-US')} MMK`;
}

function cleanupProof() {
  if (bankProofUrl) window.URL.revokeObjectURL(bankProofUrl);
  bankProofUrl = undefined;
}

async function request(action, args = {}, proof = false) {
  const response = await fetch(`${api}/api/bills`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `tma ${telegram.initData}` },
    body: JSON.stringify({ action, ...args }), credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(80_000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? 'Could not complete the request. Try again.');
  }
  if (proof && response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') {
    throw new Error('The proof response could not be displayed.');
  }
  return proof ? response.blob() : response.json();
}

async function run(work) {
  if (busy) return;
  busy = true;
  content.inert = true;
  content.setAttribute('aria-busy', 'true');
  nav.inert = true;
  message(error);
  try {
    await work();
  } catch (failure) {
    message(error, failure instanceof Error ? failure.message : 'Something went wrong. Try again.');
  } finally {
    content.inert = false;
    nav.inert = false;
    content.setAttribute('aria-busy', 'false');
    busy = false;
  }
}

function screen(title, ...nodes) {
  cleanupProof();
  heading.textContent = title;
  content.replaceChildren(...nodes);
  nav.replaceChildren(button('Back', back), button('Close', () => telegram.close()));
  nav.hidden = false;
  heading.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function open(view) {
  return run(async () => {
    message(notice);
    await render(view);
    stack.push(view);
  });
}

function back() {
  if (busy) return;
  if (stack.length < 2) {
    if (!window.BoardUI.backToBoard()) telegram?.close();
    return;
  }
  return run(async () => {
    message(notice);
    await render(stack.at(-2));
    stack.pop();
  });
}

function card() { return el('section', '', 'bill-card'); }
function row(title, meta) {
  const node = el('div', '', 'bill-row');
  node.append(el('strong', title), el('p', meta, 'bill-muted'));
  return node;
}

function numeric() {
  const input = el('input', '', 'amount-input');
  input.inputMode = 'numeric';
  input.maxLength = 19;
  input.placeholder = '0';
  return input;
}

function field(label, input) {
  const wrapper = el('label', label, 'bill-field');
  wrapper.append(input);
  return wrapper;
}

function parseMmk(value) {
  const digits = value.trim();
  if (!/^(?:[0-9]{1,15}|[0-9]{1,3}(?:,[0-9]{3}){1,4})$/.test(digits)) {
    throw new Error('Enter whole, nonnegative MMK amounts.');
  }
  return BigInt(digits.replaceAll(',', ''));
}

function previewBill(input, shares, roster) {
  const name = (id) => roster.find((member) => member.id === id).name;
  const bill = {
    id: `preview${fixtures.size + 1}`, title: input.title, total: input.total, receiver: name(input.receiverId),
    receiverId: input.receiverId, delivery: 'PREVIEW', shares: shares.map(({ memberId, share }) => ({
      id: memberId, debtorId: memberId, debtor: name(memberId), amount: share,
      status: memberId === input.receiverId || share === '0' ? 'PAID' : 'UNPAID', payments: [],
    })),
  };
  fixtures.set(bill.id, bill);
  return bill.id;
}

async function create() {
  const roster = session.preview ? session.roster : (await request('roster')).roster;
  const form = el('form', '', 'bill-form');
  const title = el('input');
  title.maxLength = 100;
  title.required = true;
  title.placeholder = 'Dinner, taxi, tickets…';
  const total = numeric();
  total.classList.add('bill-total');
  total.placeholder = '0';
  const payer = el('select');
  for (const member of roster) {
    const option = el('option', member.name);
    option.value = member.id;
    payer.append(option);
  }
  payer.value = session.actor;
  const method = el('select');
  for (const [value, label] of [['EQUAL', 'Equal Split'], ['CUSTOM', 'Custom Split']]) {
    const option = el('option', label);
    option.value = value;
    method.append(option);
  }
  const members = el('fieldset', '', 'bill-members');
  members.append(el('legend', 'Members'));
  const checks = roster.map((member) => {
    const group = el('div', '', 'bill-member');
    const check = el('input');
    check.type = 'checkbox';
    check.checked = member.id === session.actor;
    const share = numeric();
    share.setAttribute('aria-label', `Share for ${member.name}`);
    const choice = el('label', '', 'bill-choice');
    const initials = el('span', [...member.name.trim()][0]?.toUpperCase() ?? '', 'member-avatar');
    initials.setAttribute('aria-hidden', 'true');
    choice.append(check, initials, el('span', member.name));
    const estimate = el('span', '', 'bill-muted');
    group.append(choice, share, estimate);
    members.append(group);
    return { ...member, check, share, estimate };
  });
  const summary = el('p', '', 'bill-muted');
  summary.classList.add('bill-allocation');
  summary.setAttribute('aria-live', 'polite');
  function allocation(strict = false) {
    const selected = checks.filter((member) => member.check.checked)
      .sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
    const value = parseMmk(total.value);
    if (!value || !selected.length || selected.length > 30) {
      throw new Error('Enter a total above zero and choose 1 to 30 participants.');
    }
    const count = BigInt(selected.length);
    const shares = selected.map((member, index) => ({
      memberId: member.id,
      share: String(method.value === 'EQUAL' ? value / count + (BigInt(index) < value % count ? 1n : 0n)
        : parseMmk(member.share.value)),
    }));
    const sum = shares.reduce((result, item) => result + BigInt(item.share), 0n);
    if (strict && value !== sum) throw new Error('Shares must add up to the bill total.');
    return { value, sum, shares };
  }
  function refresh() {
    for (const item of checks) {
      item.share.hidden = method.value !== 'CUSTOM' || !item.check.checked;
      item.estimate.textContent = '';
    }
    try {
      const { value, sum, shares } = allocation();
      summary.textContent = method.value === 'CUSTOM' ? `Allocated ${amount(sum)} of ${amount(value)}` : `${shares.length} shares · ${amount(value)}`;
      if (method.value === 'EQUAL') {
        for (const item of shares) checks.find((member) => member.id === item.memberId).estimate.textContent = amount(item.share);
      }
    } catch {
      summary.textContent = '';
    }
  }
  const onEdit = () => {
    message(error);
    refresh();
  };
  form.addEventListener('input', onEdit);
  form.addEventListener('change', onEdit);
  const submit = el('button', session.preview ? 'Calculate & Preview' : 'Split Bill', 'primary-button');
  submit.type = 'submit';
  let signature;
  let key;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void run(async () => {
      const { value, shares } = allocation(true);
      if (!title.value.trim() || !payer.value) throw new Error('Enter a bill title and choose who paid.');
      const input = { title: title.value.trim(), total: String(value), receiverId: payer.value, method: method.value,
        participants: shares.map((item) => ({ memberId: item.memberId, ...(method.value === 'CUSTOM' ? { share: item.share } : {}) })) };
      const current = JSON.stringify(input);
      if (signature !== current) {
        signature = current;
        key = crypto.randomUUID();
      }
      const id = session.preview ? previewBill(input, shares, roster)
        : (await request('create', { bill: { ...input, requestId: key } })).id;
      const target = `bill:${id}`;
      await render(target);
      stack.push(target);
      message(notice, session.preview ? 'Simulation created for this session.' : 'Bill saved. The group announcement is queued.');
    });
  });
  const settings = el('div', '', 'bill-settings');
  settings.append(field('Who paid?', payer), field('Split method', method));
  form.append(field('Total amount (MMK)', total), field('Bill title', title), settings, members, summary, submit);
  refresh();
  screen('Split a Bill', roster.length ? form : el('p', 'No eligible members are registered.', 'bill-card bill-muted'));
}

function ledgerViews(selected) {
  const actions = el('div', '', 'bill-actions');
  for (const [key, label] of [['all', 'All Group Debts'], ['debts', 'My Debts'], ['received', 'Owed to Me'], ['settled', 'Settled History']]) {
    const control = button(label, () => open(`ledger:${key}`));
    control.setAttribute('aria-pressed', String(selected === key));
    actions.append(control);
  }
  return actions;
}

function previewRows(view) {
  return [...fixtures.values()].flatMap((bill) => bill.shares.filter((share) =>
    share.debtorId !== bill.receiverId && share.amount !== '0' &&
    (view === 'all' || (view === 'settled' && share.status === 'PAID') ||
      (view === 'debts' && share.debtorId === session.actor && share.status !== 'PAID') ||
      (view === 'received' && bill.receiverId === session.actor && share.status !== 'PAID')),
  ).map((share) => ({ ...share, title: bill.title, billId: bill.id, receiver: bill.receiver,
    outstanding: share.status === 'PAID' ? '0' : share.amount })));
}

async function list(view) {
  const mine = view === 'mine';
  const selected = view.split(':')[1] ?? (view === 'debts' ? 'debts' : 'all');
  const items = card();
  const navActions = mine ? el('div', '', 'bill-actions') : ledgerViews(selected);
  if (mine) navActions.append(
    button('Create Bill', () => open('create')),
    button('My Debts', () => open('debts')),
    button('Group Debt Ledger', () => open('ledger')),
  );
  function add(itemsList) {
    for (const item of itemsList) {
      const target = `bill:${mine ? item.id : item.billId}`;
      const itemRow = row(mine ? item.title
        : `${item.debtor} ${item.status === 'PAID' ? 'paid' : 'owes'} ${item.receiver}`,
        mine ? `${amount(item.total)} · Paid by ${item.receiverName ?? item.receiver}`
          : `${item.title} · ${amount(item.outstanding)} outstanding of ${amount(item.amount)} · ${statuses[item.status]}`);
      itemRow.append(button('View Bill', () => open(target)));
      items.append(itemRow);
    }
  }
  let next;
  const load = async () => {
    if (session.preview) return { items: mine ? [...fixtures.values()] : previewRows(selected), next: null };
    return request(mine ? 'mine' : 'ledger', { ...(mine ? {} : { view: selected }), ...(next ? { after: next } : {}) });
  };
  const first = await load();
  add(first.items);
  next = first.next;
  if (!first.items.length) items.append(el('p', mine ? 'No bills yet.' : 'No matching debts.', 'bill-muted'));
  const more = button('Load more', () => run(async () => {
    const result = await load();
    add(result.items);
    next = result.next;
    more.hidden = !next;
  }));
  more.hidden = !next;
  screen(mine ? 'My Bills' : 'Group Debt Ledger', navActions, items, more);
}

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1]));
    reader.addEventListener('error', () => reject(new Error('The image could not be read.')));
    reader.readAsDataURL(file);
  });
}

function previewPayment(bill, share, action, args) {
  const target = fixtures.get(bill.id).shares.find((item) => item.id === share.id);
  if (action === 'later') target.status = 'PAY_LATER';
  if (action === 'submit' || action === 'cash') {
    target.payments.unshift({
      id: `demo${target.payments.length + 1}`, method: args.method ?? 'CASH',
      decision: action === 'cash' ? 'CONFIRMED' : 'PENDING', hasProof: args.method === 'TRANSFER',
      previousStatus: target.status,
    });
    target.status = action === 'cash' ? 'PAID' : 'PENDING_VERIFICATION';
  }
  if (action === 'review') {
    const payment = target.payments.find((item) => item.id === args.payment);
    payment.decision = args.decision;
    target.status = args.decision === 'CONFIRMED' ? 'PAID' : payment.previousStatus;
  }
}

function paymentActions(container, bill, share) {
  const change = async (action, args, success) => {
    if (session.preview) previewPayment(bill, share, action, args);
    else await request(action, { share: share.id, ...args });
    await render(`bill:${bill.id}`);
    message(notice, success);
  };
  const actions = el('div', '', 'bill-actions');
  const openDebt = ['UNPAID', 'PAY_LATER'].includes(share.status);
  if (share.role === 'debtor' && openDebt) {
    if (share.status === 'UNPAID') actions.append(button('Pay Later', () => run(() => change('later', {}, 'Marked Pay Later.'))));
    const paid = button("I've Paid", () => {
      paid.hidden = true;
      entryPanel.hidden = false;
      entryPanel.querySelector('button').focus();
    });
    const entryPanel = el('div', '', 'bill-payment-entry');
    entryPanel.hidden = true;
    const cashKey = crypto.randomUUID();
    entryPanel.append(button('Submit cash payment', () => run(() =>
      change('submit', { requestId: cashKey, method: 'CASH' }, 'Cash payment sent for receiver verification.'))));
    if (session.preview) {
      entryPanel.append(button('Simulate screenshot upload', () => run(() =>
        change('submit', { method: 'TRANSFER' }, 'Simulated proof sent for verification.'))));
    } else {
      const upload = el('input');
      upload.type = 'file';
      upload.accept = 'image/png,image/jpeg';
      let selectedFile;
      let proofKey;
      entryPanel.append(field('Payment screenshot (PNG or JPEG, up to 1.5 MB)', upload),
        button('Upload Payment Screenshot', () => run(async () => {
          const file = upload.files[0];
          if (!file || !file.size || file.size > 1_500_000 || !['image/png', 'image/jpeg'].includes(file.type)) {
            throw new Error('Choose a PNG or JPEG up to 1.5 MB.');
          }
          if (selectedFile !== file) {
            selectedFile = file;
            proofKey = crypto.randomUUID();
          }
          await change('submit', { requestId: proofKey, method: 'TRANSFER', image: await asBase64(file) },
            'Proof sent for receiver verification.');
        })));
    }
    actions.append(paid);
    container.append(actions, entryPanel);
  }
  if (share.role === 'receiver' && openDebt) {
    const key = crypto.randomUUID();
    actions.append(button('Confirm Cash Received', () => run(() =>
      change('cash', { requestId: key }, 'Cash receipt confirmed.'))));
    container.append(actions);
  }
  if (!share.payments.length) return;
  const history = el('details', '', 'bill-history');
  history.open = share.status === 'PENDING_VERIFICATION';
  history.append(el('summary', 'Payment Status'));
  for (const payment of share.payments) {
    const review = row(payment.method === 'CASH' ? 'Cash payment' : 'Transfer payment',
      `${{ PENDING: 'Pending verification', CONFIRMED: 'Confirmed', REJECTED: 'Correction requested' }[payment.decision]}${payment.createdAt ? ` · ${new Date(payment.createdAt).toLocaleString()}` : ''}`);
    if (share.role === 'debtor' && payment.decision === 'PENDING' &&
        ['FAILED', 'UNKNOWN'].includes(payment.notificationStatus)) {
      review.append(el('p', 'Private notification could not be verified. The receiver can review the payment in Owed to Me.', 'bill-muted'));
    }
    const reviewActions = el('div', '', 'bill-actions');
    if (payment.hasProof) reviewActions.append(button('View Proof', () => run(async () => {
      if (session.preview) {
        screen('Proof preview', el('p', 'Simulated receipt. No image was captured or stored.', 'bill-card bill-muted'));
      } else {
        const blob = await request('proof', { payment: payment.id }, true);
        screen('Private payment proof');
        bankProofUrl = window.URL.createObjectURL(blob);
        const image = el('img', '', 'bill-proof');
        image.alt = 'Payment screenshot';
        image.src = bankProofUrl;
        content.append(image);
      }
      stack.push('proof');
    })));
    if (share.role === 'receiver' && payment.decision === 'PENDING') {
      reviewActions.append(button('Confirm Received', () => run(() =>
        change('review', { payment: payment.id, decision: 'CONFIRMED' }, 'Payment confirmed.'))),
      button('Request Correction', () => run(() =>
        change('review', { payment: payment.id, decision: 'REJECTED' }, 'Correction requested.')), 'danger-button'));
    }
    review.append(reviewActions);
    history.append(review);
  }
  container.append(history);
}

async function detail(id) {
  const bill = session.preview ? fixtures.get(id) : await request('bill', { id });
  if (!bill) throw new Error('Bill unavailable.');
  const header = card();
  header.append(row(amount(bill.total), `Paid by ${bill.receiver}`));
  if (session.preview) {
    const previews = el('div', '', 'bill-actions');
    for (const [key, label] of [['debtor', 'Debtor Preview'], ['receiver', 'Receiver Preview'], ['member', 'Shared View']]) {
      const control = button(label, () => run(async () => { role = key; await detail(id); }));
      control.setAttribute('aria-pressed', String(role === key));
      previews.append(control);
    }
    const announcement = el('details', '', 'bill-history');
    announcement.append(el('summary', 'Group Announcement Preview'),
      row(bill.title, `${amount(bill.total)} · Paid by ${bill.receiver}`),
      ...bill.shares.map((share) => row(share.debtor, `${amount(share.amount)} · ${statuses[share.status]}`)),
      el('p', 'View Bill · Debt Status', 'bill-muted'));
    header.append(previews, announcement);
  } else if (bill.delivery) {
    header.append(el('p', deliveryStatus[bill.delivery], 'bill-muted'));
    if (bill.delivery === 'FAILED') header.append(button('Retry announcement', () => run(async () => {
      await request('retry', { id });
      await detail(id);
    })));
  }
  if (!session.preview) header.append(button('Refresh bill', () => run(() => detail(id))));
  const rows = card();
  rows.append(el('h2', 'Shares'));
  const sampleDebtor = bill.shares.find((share) => share.debtorId === session.actor && share.debtorId !== bill.receiverId && share.amount !== '0')
    ?? bill.shares.find((share) => share.debtorId !== bill.receiverId && share.amount !== '0');
  for (const share of bill.shares) {
    const shareRow = row(share.debtor, `${amount(share.amount)} · ${amount(share.status === 'PAID' ? '0' : share.amount)} outstanding`);
    const status = el('span', statuses[share.status], 'bill-status');
    status.dataset.status = share.status;
    shareRow.append(status);
    const shown = session.preview ? {
      ...share, role: share.debtorId === bill.receiverId || share.amount === '0' ? null
        : role === 'receiver' ? 'receiver' : role === 'debtor' && share.id === sampleDebtor?.id ? 'debtor' : null,
    } : share;
    if (shown.role) paymentActions(shareRow, bill, shown);
    rows.append(shareRow);
  }
  const options = el('div', '', 'bill-actions');
  options.append(button('My Bills', () => open('mine')), button('Group Debt Ledger', () => open('ledger')));
  screen(bill.title, header, rows, options);
}

async function render(view) {
  if (view === 'create') return create();
  if (view.startsWith('bill:')) return detail(view.slice(5));
  return list(view);
}

telegram?.BackButton?.onClick(back);
telegram?.BackButton?.show();
telegram?.ready();
telegram?.expand();
window.addEventListener('pagehide', cleanupProof);

async function start() {
  session = await request('session');
  if (session.preview) {
    document.querySelector('#simulation').hidden = false;
    previewBill({ title: 'Dinner example (fixture)', total: '30000', receiverId: '2' },
      [{ memberId: '1', share: '10000' }, { memberId: '2', share: '10000' }, { memberId: '3', share: '10000' }], session.roster);
  }
  const initial = /^(create|mine|debts|ledger|bill:[a-z0-9]{1,32})$/.test(entry) ? entry : 'create';
  await render(initial);
  stack.push(initial);
}

if (telegram?.initData) {
  void run(start).finally(() => {
    if (!session || !stack.length) content.replaceChildren(button('Try again', () => run(start)));
  });
} else {
  message(error, 'Open Bill Splitter from the bot’s private chat in Telegram.');
  content.replaceChildren();
  content.setAttribute('aria-busy', 'false');
}

