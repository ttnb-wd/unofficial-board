const telegram = window.Telegram?.WebApp;
const get = (id) => document.getElementById(`hangout-${id}`);
const form = get('form');
const content = get('content');
const navigation = get('navigation');
const loading = get('loading');
const error = get('error');
const zone = 'Asia/Yangon';
const listViews = ['active', 'mine', 'completed'];
const titles = {
  menu: 'One Tap Hangout', create: 'Create Hangout', edit: 'Edit Hangout',
  active: 'Active Hangouts', mine: 'My Hangouts', completed: 'Completed Hangouts',
  detail: 'Hangout Details', preview: 'Group Invitation Preview', member: 'Member View',
};
const choices = { GOING: '🙌 Going', MAYBE: '🤔 Maybe', CANT: "😔 Can't" };
const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone });
const formFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

let current = { view: 'menu' };
let routeToken = 0;
let busy = false;
let preview = false;
let events;
let dashboardUrl;
let clockAt = Date.now();
let anchor = performance.now();
let wallAnchor = Date.now();
let lastServerTime = -Infinity;
let refreshState;
const now = () => clockAt + performance.now() - anchor;

function message(value = '') {
  error.textContent = value;
  error.hidden = !value;
}

function node(tag, text, css) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  if (css) element.className = css;
  return element;
}

function button(text, click, css) {
  const element = node('button', text, css);
  element.type = 'button';
  element.addEventListener('click', click);
  return element;
}

async function api(action, payload = {}) {
  if (!telegram?.initData) throw new Error('Open One Tap Hangout from the private bot chat.');
  const response = await fetch(`${window.BOARD_API_ORIGIN || ''}/api/hangouts`, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(45_000),
    headers: { Authorization: `tma ${telegram.initData}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.error || 'Could not reach One Tap Hangout. Try again.');
  const serverTime = Date.parse(result.serverNow);
  if (Number.isFinite(serverTime) && serverTime >= lastServerTime) {
    clockAt = lastServerTime = serverTime;
    anchor = performance.now();
    wallAnchor = Date.now();
  }
  return result;
}

function formatParts(date) {
  const parts = Object.fromEntries(formFormat.formatToParts(date).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function saveSimulation() {
  try { sessionStorage.setItem('hangout-simulation', JSON.stringify(events)); } catch {
    // The simulation remains usable in memory when session storage is unavailable.
  }
}

function simulationFixtures() {
  try {
    const stored = JSON.parse(sessionStorage.getItem('hangout-simulation') || 'null');
    if (Array.isArray(stored) && stored.some((event) => event.id === 'pizza')) return stored;
  } catch {
    // Invalid or unavailable storage falls back to fictional fixtures.
  }
  const titles = ['Pizza Night', 'Arcade Night', 'Beach Day', 'Morning Walk', 'Potluck', 'Board Games', 'Night Market',
    'Karaoke', 'Book Swap', 'Sunday Coffee', 'Last Week’s Brunch'];
  return titles.map((title, index) => ({
    id: index === 0 ? 'pizza' : `demo-${index}`,
    startsAt: new Date(now() + (index === 10 ? -24 : 3 + Math.max(0, index - 1) * 12) * 3_600_000).toISOString(),
    title, place: index === 0 ? 'Pizza Place' : '', description: index === 0 ? 'Meet at the front table.' : '',
    version: 1, owned: index % 2 === 0, status: 'OPEN',
    participants: index === 0 ? [
      { key: 'avery', displayName: 'Avery (fictional)', response: 'GOING' },
      { key: 'sam', displayName: 'Sam (fictional)', response: 'MAYBE' },
      { key: 'jules', displayName: 'Jules (fictional)', response: 'CANT' },
    ] : [],
  }));
}

function statusOf(event) {
  return event.status === 'OPEN' && Date.parse(event.startsAt) <= now() ? 'COMPLETED' : event.status;
}

function simulate(action, data, member) {
  const participant = member ? 'guest' : 'owner';
  const present = (event) => ({
    ...event, owned: event.owned && !member, status: statusOf(event),
    counts: Object.fromEntries(Object.keys(choices).map((choice) => [choice, event.participants.filter(({ response }) => response === choice).length])),
    myRsvp: event.participants.find(({ key }) => key === participant)?.response ?? null,
  });
  if (listViews.includes(action)) {
    const descending = action === 'completed';
    const sorted = events.filter((event) => action === 'mine' ? event.owned : statusOf(event) === (descending ? 'COMPLETED' : 'OPEN'))
      .sort((a, b) => (descending ? -1 : 1) * (a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id)));
    const offset = data.cursor ? sorted.findIndex(({ id }) => id === data.cursor.id) + 1 : 0;
    const page = sorted.slice(offset, offset + 8);
    const last = sorted.length > offset + 8 ? page.at(-1) : null;
    return { hangouts: page.map(present), nextCursor: last ? { id: last.id, startsAt: last.startsAt } : null };
  }
  let event = events.find(({ id }) => id === (data.id || data.requestId));
  if (action === 'detail' || (action === 'create' && event)) {
    if (!event) throw new Error('Hangout not found.');
    return { hangout: present(event) };
  }
  if (action !== 'create' && (!event || statusOf(event) !== 'OPEN')) throw new Error('This hangout has closed.');
  if (['edit', 'cancel'].includes(action) && (member || !event.owned || data.version !== event.version)) {
    throw new Error('This hangout changed or is unavailable.');
  }
  if (action === 'rsvp') {
    event.participants = [...event.participants.filter(({ key }) => key !== participant), {
      key: participant, displayName: member ? 'Casey (fictional)' : 'You (preview)', response: data.response,
    }];
  } else if (action === 'cancel') {
    event.status = 'CANCELLED';
    event.version++;
  } else {
    const starts = Date.parse(`${data.date}T${data.time}:00+06:30`);
    if (!data.title || !Number.isFinite(starts) || starts <= now()) throw new Error('Enter a title and choose a future time in Yangon.');
    const { title, place, description } = data;
    const updates = { title, place, description, startsAt: new Date(starts).toISOString() };
    if (action === 'edit') Object.assign(event, updates, { version: event.version + 1 });
    else {
      event = { ...updates, id: data.requestId, status: 'OPEN', owned: true, version: 1, participants: [] };
      events.push(event);
    }
  }
  saveSimulation();
  return { hangout: present(event) };
}

const run = (action, data = {}, member = false) => preview ? simulate(action, data, member) : api(action, data);

function counters(event) {
  const group = node('div', '', 'hangout-counters');
  for (const [choice, label] of Object.entries(choices)) {
    const count = node('div', '', 'hangout-counter');
    count.append(node('strong', String(event.counts[choice])), node('span', label));
    group.append(count);
  }
  return group;
}

function summary(event, heading) {
  const card = node('article', '', 'bill-card hangout-card');
  card.append(heading, node('p', `${dateFormat.format(new Date(event.startsAt))} · Yangon`, 'bill-muted'));
  if (event.place) card.append(node('p', `📍 ${event.place}`));
  return card;
}

function participants(event) {
  const card = node('section', '', 'bill-card hangout-card');
  card.append(node('h2', 'Participants'));
  for (const [choice, label] of Object.entries(choices)) {
    const names = event.participants.filter(({ response }) => response === choice);
    const heading = node('h3', `${label} · ${names.length}`);
    card.append(heading);
    if (names.length) {
      const list = node('ul');
      for (const { displayName } of names) list.append(node('li', displayName));
      card.append(list);
    } else card.append(node('p', 'No responses', 'bill-muted'));
  }
  return card;
}

function renderEvent(event, route) {
  const member = route.view === 'member' || route.view === 'preview';
  const invitation = route.view === 'preview';
  const heading = node('h2', invitation ? `🍕 ${event.title}` : event.title);
  const card = summary(event, heading);
  if (event.description) card.append(node('p', event.description, 'hangout-description'));
  const state = node('p', '', 'hangout-state');
  state.setAttribute('role', 'status');
  const actions = node('div', '', 'hangout-rsvp');
  for (const [choice, label] of Object.entries(choices)) {
    const answer = button(label, () => void mutate('rsvp', { id: event.id, response: choice }, route, member));
    answer.setAttribute('aria-pressed', String(choice === event.myRsvp));
    actions.append(answer);
  }
  card.append(state, counters(event),
    node('p', `My RSVP · ${event.myRsvp ? choices[event.myRsvp] : 'No response'}`, 'hangout-my-rsvp'),
    actions,
  );
  if (invitation) {
    card.append(button('View Details', () => void open('member', { id: event.id, parent: route }), 'hangout-preview-link'));
  }
  content.append(card);
  if (!invitation) content.append(participants(event));
  const management = node('div', '', 'bill-actions');
  if (event.owned && !member) {
    management.append(button('Edit Hangout', () => void open('edit', { event, id: event.id, parent: route })),
      button('Cancel Hangout', () => {
        if (window.confirm('Cancel this hangout?')) void mutate('cancel', { id: event.id, version: event.version }, route);
      }, 'danger-button'));
  }
  content.append(management);
  if (preview && route.view === 'detail') {
    content.append(button('Preview This Invitation', () => void open('preview', { id: event.id, parent: route })));
  }
  refreshState = () => {
    const status = statusOf(event);
    const text = status === 'OPEN' ? (invitation ? "Who's coming?" : '') :
      status === 'CANCELLED' ? 'Cancelled' : 'Hangout started · RSVP closed';
    if (state.textContent !== text) state.textContent = text;
    state.hidden = !text;
    actions.hidden = status !== 'OPEN';
    management.hidden = status !== 'OPEN' || !management.childElementCount;
  };
  refreshState();
}

function renderList(result, view, pages) {
  if (!result.hangouts.length) content.append(node('p', 'No hangouts here yet.', 'bill-card'));
  for (const event of result.hangouts) {
    const title = node('h2');
    title.append(button(event.title, () => void open('detail', { id: event.id, parent: { view, pages } }), 'hangout-list-title'));
    const card = summary(event, title);
    const status = statusOf(event);
    if (status !== 'OPEN') card.append(node('p', status === 'CANCELLED' ? 'Cancelled' : 'Started', 'hangout-state'));
    card.append(counters(event));
    content.append(card);
  }
  if (pages.length || result.nextCursor) {
    const pager = node('nav', '', 'bill-actions hangout-pager');
    pager.setAttribute('aria-label', 'Hangout pages');
    const prev = button('Previous', () => void open(view, { pages: pages.slice(0, -1) }));
    const next = button('Next', () => void open(view, { pages: [...pages, result.nextCursor] }));
    prev.disabled = !pages.length;
    next.disabled = !result.nextCursor;
    pager.append(prev, node('span', `Page ${pages.length + 1}`), next);
    content.append(pager);
  }
}

function renderForm(event) {
  form.reset();
  get('date').min = formatParts(new Date(now())).date;
  if (event) {
    const parts = formatParts(new Date(event.startsAt));
    for (const [key, value] of Object.entries({ ...parts, title: event.title, place: event.place, description: event.description })) {
      form.elements[key].value = value;
    }
  }
  get('save').textContent = event ? 'Save Changes' : 'Create Hangout';
  form.hidden = false;
}

async function open(view, options = {}, supplied) {
  if (!Object.hasOwn(titles, view) || (!preview && ['preview', 'member'].includes(view))) view = 'menu';
  const token = ++routeToken;
  const url = new URL(location.href);
  url.searchParams.set('view', view === 'edit' ? 'detail' : view);
  if (options.id) url.searchParams.set('id', options.id);
  else url.searchParams.delete('id');
  const draft = view === 'create' ? url.searchParams.get('draft') || crypto.randomUUID() : null;
  if (draft) url.searchParams.set('draft', draft);
  else url.searchParams.delete('draft');
  history.replaceState(null, '', url);
  current = { ...options, view, draft };
  message();
  refreshState = undefined;
  form.hidden = true;
  content.hidden = true;
  content.replaceChildren();
  get('heading').textContent = titles[view];
  get('back').hidden = view === 'menu';
  if (view === 'menu') telegram?.BackButton?.hide();
  else telegram?.BackButton?.show();
  loading.hidden = false;
  try {
    if (view === 'create' || view === 'edit') renderForm(options.event);
    if (listViews.includes(view)) {
      const pages = options.pages ?? [];
      const result = await run(view, { cursor: pages.at(-1) });
      if (token !== routeToken) return;
      renderList(result, view, pages);
    }
    if (['detail', 'member', 'preview'].includes(view)) {
      const event = supplied ?? (await run('detail', { id: options.id ?? 'pizza' }, view !== 'detail')).hangout;
      if (token !== routeToken) return;
      renderEvent(event, current);
    }
    if (view === 'menu') {
      for (const item of ['create', ...listViews, ...(preview ? ['preview', 'member'] : [])]) {
        content.append(button(titles[item], () => void open(item), item === 'create' ? 'primary-button' : undefined));
      }
    }
    content.hidden = !content.childElementCount;
  } catch (failure) {
    if (token !== routeToken) return;
    message(failure.message);
    content.append(button('Try Again', () => void open(view, options)));
    content.hidden = false;
  } finally {
    if (token === routeToken) loading.hidden = true;
  }
}

function blocked(value) {
  busy = value;
  navigation.inert = value;
  content.inert = value;
  form.inert = value;
}

async function mutate(action, payload, route, member = false) {
  if (busy) return;
  blocked(true);
  message();
  try {
    const { hangout } = await run(action, payload, member);
    const view = action === 'create' || action === 'edit' ? 'detail' : route.view;
    const parent = action === 'edit' ? route.parent?.parent : route.parent;
    await open(view, { id: hangout.id, parent }, hangout);
  } catch (failure) {
    message(failure.message);
  } finally {
    blocked(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
  if (!data.title) { message('Enter a hangout title.'); return; }
  const editing = current.view === 'edit';
  void mutate(editing ? 'edit' : 'create', {
    ...data, timeZone: zone, ...(editing ? { id: current.id, version: current.event.version } : { requestId: current.draft }),
  }, current);
});

get('today').addEventListener('click', () => {
  get('date').value = formatParts(new Date(now())).date;
  get('time').focus();
});

function back() {
  if (busy) return;
  const parent = current.parent ?? { view: 'menu' };
  void open(parent.view, parent);
}
get('back').addEventListener('click', back);
get('main-menu').addEventListener('click', () => {
  if (dashboardUrl) telegram?.openTelegramLink?.(dashboardUrl);
  telegram?.close();
});

setInterval(() => refreshState?.(), 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const elapsed = Date.now() - wallAnchor;
  if (elapsed > performance.now() - anchor + 2000) {
    clockAt += elapsed;
    anchor = performance.now();
    wallAnchor = Date.now();
  }
  refreshState?.();
  void api('session').then(() => refreshState?.()).catch(() => {});
});

async function initialize() {
  message();
  loading.hidden = false;
  try {
    const session = await api('session');
    preview = session.preview;
    dashboardUrl = session.dashboardUrl;
    if (preview) events = simulationFixtures();
    get('preview').hidden = !preview;
    navigation.hidden = false;
    telegram?.BackButton?.onClick(back);
    const params = new URLSearchParams(location.search);
    await open(params.get('view') || 'menu', { id: params.get('id') ?? undefined });
  } catch (failure) {
    loading.hidden = true;
    message(failure.message);
    content.replaceChildren(button('Try Again', () => void initialize()));
    content.hidden = false;
  }
}
telegram?.ready();
telegram?.expand();
void initialize();
