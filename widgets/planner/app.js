/* Post Grid Planner — YouTrack PROJECT_TAB widget
 *
 * Right: monthly calendar (every project issue that has a date). "+" creates a new post (= issue)
 *        with an optional image attachment. Drag a post to another day to reschedule it.
 * Left:  Instagram profile grid — only issues with Type = "Instagram Post".
 *        Latest date on top; the earlier the date, the further down. 3×3 visible, the rest scrolls.
 *
 * Cover image: when a post has several images, the grid shows the one whose file name contains
 * "cover", or the one attached in a comment whose text contains "cover". Otherwise the first image.
 *
 * Opened outside YouTrack (no YTApp), it runs in preview mode with sample data.
 */

/* ---------------------------------------------------------------- settings */

const PREFERRED_DATE_FIELDS = ['Publish Date', 'Post Date', 'Due Date', 'Yayın Tarihi', 'Paylaşım Tarihi']; // first match = post date
const AD_START_RE = /\bad\b.*start|reklam.*ba[şs]la/i;   // e.g. "Ad Start Date"
const AD_END_RE = /\bad\b.*end|reklam.*bit/i;            // e.g. "Ad End Date"
const IG_FIELD_NAMES = ['Type', 'Tür', 'Tip'];   // field that marks Instagram posts
const IG_VALUE_RE = /instagram\s*post/i;         // ...and its value
const ACCOUNT_FIELD_RE = /product|department|brand|account|ürün|departman|marka/i; // fields that split the feed into accounts
const COVER_RE = /cover/i;                       // in a file name or comment text → cover image
const MIN_TILES = 9;
const AUTO_REFRESH_MS = 60_000;
const DEFAULT_FEED_W = 340;
const DEFAULT_APP_H = 860;   // YouTrack sizes the frame from the content height
const MIN_APP_H = 380;

/* ---------------------------------------------------------------- host */

const IS_PREVIEW = typeof window.YTApp === 'undefined';
// Outside YouTrack the source build runs on sample data; the release build has no preview code (host = null).
const host = IS_PREVIEW ? (typeof createMockHost === 'function' ? createMockHost() : null) : await window.YTApp.register();
const entity = IS_PREVIEW ? { id: '0-1', type: 'project' } : window.YTApp.entity;
const LOCALE = (!IS_PREVIEW && window.YTApp.locale) || 'en-US';

/* ---------------------------------------------------------------- state */

const state = {
  project: null,
  dateFields: [],
  dateField: null,      // {name, type}  post date (Publish Date)
  adStart: null,        // {name, type}  Ad Start Date
  adEnd: null,          // {name, type}  Ad End Date
  igField: null,        // {name, type, value}, e.g. Type / enum[1] / "Instagram Post"
  accountFields: [],    // [{name, type, values}] e.g. Product, Department
  issues: [],
  cursor: startOfMonth(new Date()),
  loading: false,
  saving: false,
  editingIssue: null,
  pendingFile: null,
  ui: { size: 'fit', feedW: DEFAULT_FEED_W, onlyIG: false, appH: null, account: null }, // account: {field, value}; value '' = unassigned
};

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- utils */

function pad(n) { return String(n).padStart(2, '0'); }
function keyOf(y, m, d) { return `${y}-${pad(m + 1)}-${pad(d)}`; }
function keyOfDate(dt) { return keyOf(dt.getFullYear(), dt.getMonth(), dt.getDate()); }
function startOfMonth(dt) { return new Date(dt.getFullYear(), dt.getMonth(), 1); }
function todayKey() { return keyOfDate(new Date()); }
function tsToKey(ts, type) {
  const d = new Date(ts);
  // "date" fields are stored as noon UTC → use UTC parts
  return type === 'date' ? keyOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : keyOfDate(d);
}
function keyToTs(key, type) {
  const [y, m, d] = key.split('-').map(Number);
  return type === 'date' ? Date.UTC(y, m - 1, d, 12) : new Date(y, m - 1, d, 10, 0).getTime();
}
function fmtDay(key, opts = { day: 'numeric', month: 'short' }) {
  const [y, m, d] = key.split('-').map(Number);
  return new Intl.DateTimeFormat(LOCALE, opts).format(new Date(y, m - 1, d));
}
let ytContextPath = null;   // from GET /api/config?fields=contextPath

/** YouTrack base URL for links: origin + contextPath (e.g. "/youtrack" on Server, "" on Cloud). */
function ytBase() {
  if (ytContextPath != null) {
    if (/^https?:/i.test(ytContextPath)) return ytContextPath.replace(/\/$/, '');
    return ytOrigin() + ytContextPath.replace(/\/$/, '');
  }
  // Fallback: derive it from the page that embeds the widget
  try {
    const ref = document.referrer || (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
    if (ref) {
      const u = new URL(ref);
      const cut = u.pathname.search(/\/(projects|issue|issues|agiles|dashboard|app|admin)(\/|$)/);
      return u.origin + (cut > 0 ? u.pathname.slice(0, cut) : '');
    }
  } catch { /* ignore */ }
  return location.origin !== 'null' ? location.origin : '';
}
function ytOrigin() {
  try {
    if (location.ancestorOrigins && location.ancestorOrigins[0]) return location.ancestorOrigins[0];
    if (document.referrer) return new URL(document.referrer).origin;
  } catch { /* ignore */ }
  return location.origin !== 'null' ? location.origin : '';
}
function absUrl(u) {
  if (!u) return null;
  if (/^(https?:|data:|blob:)/i.test(u)) return u;
  return ytOrigin() + (u.startsWith('/') ? u : '/' + u);
}
function issueUrl(issue) { return IS_PREVIEW ? '#' : `${ytBase()}/issue/${issue.idReadable}`; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function errText(e) {
  return e?.data?.error_description || e?.data?.error || e?.message || String(e);
}
let toastTimer;
function toast(msg, ms = 3200) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
let statusMsg = '';
function setStatus(msg, isErr = false) {
  statusMsg = msg || '';
  const el = $('status');
  el.classList.toggle('err', !!isErr);
  el.textContent = statusMsg;
}
async function storageGet(key) {
  try { return host?.storage ? await host.storage.getItem(key) : null; } catch { return null; }
}
async function storageSet(key, val) {
  try { if (host?.storage) await host.storage.setItem(key, val); } catch { /* ignore */ }
}
function saveUi() { storageSet('ui', JSON.stringify(state.ui)); }

/* ---------------------------------------------------------------- data */

const IG_TYPES = {
  'enum[1]': 'SingleEnumIssueCustomField',
  'enum[*]': 'MultiEnumIssueCustomField',
  'ownedField[1]': 'SingleOwnedIssueCustomField',
  'ownedField[*]': 'MultiOwnedIssueCustomField',
  'state[1]': 'StateIssueCustomField',
  'version[1]': 'SingleVersionIssueCustomField',
  'build[1]': 'SingleBuildIssueCustomField',
};

async function loadContextPath() {
  try {
    const cfg = await host.fetchYouTrack('config?fields=contextPath');
    if (typeof cfg?.contextPath === 'string') ytContextPath = cfg.contextPath;
  } catch { /* keep the fallback */ }
}

async function loadProject() {
  loadContextPath();
  state.project = await host.fetchYouTrack(`admin/projects/${entity.id}?fields=id,name,shortName,iconUrl,description`);

  // Project admins can read the project's field list directly…
  let cfs = [];
  try {
    cfs = await host.fetchYouTrack(
      `admin/projects/${entity.id}/customFields?fields=field(name,fieldType(id)),bundle(values(name,archived))&$top=200`);
  } catch (e) { console.warn('Project field list not readable', e); }
  let all = (cfs || []).map((c) => ({
    name: c.field?.name, type: c.field?.fieldType?.id,
    values: (c.bundle?.values || []).filter((v) => !v.archived).map((v) => v.name),
  })).filter((f) => f.name);
  // …other users get an empty list, so learn the fields from the project's issues instead
  if (!all.some((f) => f.type === 'date' || f.type === 'date and time')) {
    all = mergeFields(all, await fieldsFromIssues());
  }

  const dates = all.filter((f) => f.name && (f.type === 'date' || f.type === 'date and time'));
  state.adStart = dates.find((f) => AD_START_RE.test(f.name)) || null;
  state.adEnd = dates.find((f) => AD_END_RE.test(f.name)) || null;
  // Ad dates are never the post date
  state.dateFields = dates.filter((f) => f !== state.adStart && f !== state.adEnd);
  const saved = await storageGet(`postDateField:${entity.id}`);
  state.dateField =
    state.dateFields.find((f) => f.name === saved) ||
    PREFERRED_DATE_FIELDS.map((n) => state.dateFields.find((f) => f.name === n)).find(Boolean) ||
    state.dateFields[0] || null;

  // Instagram field: "Instagram Post" value in Type (or another field that has it)
  state.igField = null;
  for (const n of IG_FIELD_NAMES) {
    const f = all.find((x) => x.name === n);
    const v = f?.values.find((x) => IG_VALUE_RE.test(x));
    if (f && v) { state.igField = { name: f.name, type: f.type, value: v }; break; }
  }
  if (!state.igField) {
    const f = all.find((x) => x.values.some((v) => IG_VALUE_RE.test(v)));
    if (f) state.igField = { name: f.name, type: f.type, value: f.values.find((v) => IG_VALUE_RE.test(v)) };
  }

  // Account fields (Product, Department…): single/multi value fields with a value list
  state.accountFields = all.filter((f) => f.name && ACCOUNT_FIELD_RE.test(f.name) && IG_TYPES[f.type]
    && f.values.length && f.name !== state.igField?.name);
  const acc = state.ui.account;
  if (acc && !(state.accountFields.some((f) => f.name === acc.field && (acc.value === '' || f.values.includes(acc.value))))) {
    state.ui.account = null;
  }
}

/** Does the issue belong to the selected account? No selection = every account. */
function inAccount(it, acc = state.ui.account) {
  if (!acc) return true;
  const v = it.accounts[acc.field] || [];
  return acc.value === '' ? v.length === 0 : v.includes(acc.value);
}
function inFeed(it) { return it.ig && inAccount(it); }
function accountLabel(it) {
  return state.accountFields.map((f) => (it.accounts[f.name] || []).join(', ')).filter(Boolean).join(' · ');
}
function slug(s) { return String(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, ''); }
function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; }

// Issue custom field $type → field type id (used when the field type itself isn't readable)
const ISSUE_CF_TYPES = {
  DateIssueCustomField: 'date',
  SingleEnumIssueCustomField: 'enum[1]', MultiEnumIssueCustomField: 'enum[*]',
  SingleOwnedIssueCustomField: 'ownedField[1]', MultiOwnedIssueCustomField: 'ownedField[*]',
  StateIssueCustomField: 'state[1]', StateMachineIssueCustomField: 'state[1]',
  SingleVersionIssueCustomField: 'version[1]', MultiVersionIssueCustomField: 'version[*]',
  SingleBuildIssueCustomField: 'build[1]', MultiBuildIssueCustomField: 'build[*]',
};

/** Field list for users who can read issues but not the project settings. */
async function fieldsFromIssues() {
  const fields = 'customFields($type,name,value(name),projectCustomField(field(name,fieldType(id)),bundle(values(name,archived))))';
  let issues = [];
  try {
    issues = await host.fetchYouTrack(`issues?query=${encodeURIComponent(`project: {${state.project.shortName}}`)}`
      + `&$top=200&fields=${encodeURIComponent(fields)}`);
  } catch (e) { console.warn('Could not read fields from issues', e); return []; }
  const byName = new Map();
  for (const it of issues || []) {
    for (const cf of it.customFields || []) {
      if (!cf.name) continue;
      const f = byName.get(cf.name) || { name: cf.name, type: null, values: new Set() };
      f.type = f.type || cf.projectCustomField?.field?.fieldType?.id || ISSUE_CF_TYPES[cf.$type] || null;
      for (const v of cf.projectCustomField?.bundle?.values || []) if (!v.archived && v.name) f.values.add(v.name);
      for (const n of cfValueNames(cf)) f.values.add(n);   // values seen on issues
      byName.set(cf.name, f);
    }
  }
  return [...byName.values()].map((f) => ({ ...f, values: [...f.values] }));
}

function mergeFields(a, b) {
  const out = new Map(a.map((f) => [f.name, { ...f, values: [...f.values] }]));
  for (const f of b) {
    const cur = out.get(f.name);
    if (!cur) out.set(f.name, f);
    else { cur.type = cur.type || f.type; cur.values = [...new Set([...cur.values, ...f.values])]; }
  }
  return [...out.values()];
}

function cfValueNames(cf) {
  const v = cf?.value;
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => x?.name).filter(Boolean);
}

/** Attachment ids marked as cover by a comment that contains "cover" (image added in that comment). */
function coverIdsFromComments(comments, attachments) {
  const ids = new Set();
  for (const c of comments || []) {
    if (c.deleted || !COVER_RE.test(c.text || '')) continue;
    for (const a of c.attachments || []) ids.add(a.id);
    // Inline images referenced in the comment markdown: ![](image.png)
    for (const m of (c.text || '').matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      const ref = decodeURIComponent(m[1]);
      const hit = (attachments || []).filter((a) => a.name === ref);
      if (hit.length) ids.add(hit[hit.length - 1].id);
    }
  }
  return ids;
}

/**
 * Cover = an image whose file name contains "cover" or that was marked by a comment
 * (the most recently added one wins). Otherwise the first added image.
 * The cover is always first in the returned array.
 */
function orderWithCover(images, commentIds = new Set()) {
  for (const im of images) im.coverBy = COVER_RE.test(im.name) ? 'name' : commentIds.has(im.id) ? 'comment' : null;
  const marked = images.filter((im) => im.coverBy);
  const cover = marked.length ? marked[marked.length - 1] : images[0];
  const out = cover ? [cover, ...images.filter((im) => im !== cover)] : [];
  out.coverMarked = marked.length > 0;
  return out;
}

async function loadIssues() {
  const f = state.dateField;
  const q = `project: {${state.project.shortName}} has: {${f.name}}`;
  const fields = 'id,idReadable,summary,created,resolved,'
    + 'customFields(name,value(name,color(background))),'
    + 'attachments(id,name,mimeType,url,thumbnailURL,created),'
    + 'comments(text,deleted,attachments(id))';
  let url = `issues?query=${encodeURIComponent(q)}&$top=2000&fields=${encodeURIComponent(fields)}`
    + `&customFields=${encodeURIComponent(f.name)}&customFields=State`;
  if (state.igField) url += `&customFields=${encodeURIComponent(state.igField.name)}`;
  for (const af of state.accountFields) url += `&customFields=${encodeURIComponent(af.name)}`;
  for (const df of [state.adStart, state.adEnd]) if (df) url += `&customFields=${encodeURIComponent(df.name)}`;
  const raw = await host.fetchYouTrack(url);

  state.issues = (raw || []).map((it) => {
    const cfs = it.customFields || [];
    const cf = cfs.find((c) => c.name === f.name);
    const st = cfs.find((c) => c.name === 'State');
    const igCf = state.igField && cfs.find((c) => c.name === state.igField.name);
    const imgAtts = (it.attachments || []).filter((a) => (a.mimeType || '').startsWith('image/'));
    const images = orderWithCover(
      imgAtts
        .sort((a, b) => (a.created || 0) - (b.created || 0))
        .map((a) => ({ id: a.id, name: a.name || '', created: a.created || 0, url: absUrl(a.url), thumb: absUrl(a.thumbnailURL || a.url) })),
      coverIdsFromComments(it.comments, imgAtts));
    return {
      id: it.id,
      idReadable: it.idReadable,
      summary: it.summary || '(untitled)',
      created: it.created || 0,
      resolved: !!it.resolved,
      state: st?.value?.name || null,
      stateColor: st?.value?.color?.background || null,
      ig: state.igField ? cfValueNames(igCf).some((n) => IG_VALUE_RE.test(n)) : true,
      accounts: Object.fromEntries(state.accountFields.map((af) => [af.name, cfValueNames(cfs.find((c) => c.name === af.name))])),
      key: typeof cf?.value === 'number' ? tsToKey(cf.value, f.type) : null,
      adStart: dateKeyOf(cfs, state.adStart),
      adEnd: dateKeyOf(cfs, state.adEnd),
      images,
    };
  }).filter((i) => i.key);
}

function dateKeyOf(cfs, field) {
  if (!field) return null;
  const v = cfs.find((c) => c.name === field.name)?.value;
  return typeof v === 'number' ? tsToKey(v, field.type) : null;
}

/** Ad status for today: 'active' (between Ad Start and Ad End), 'scheduled', 'ended' or null (no ad). */
function adStatus(it, today = todayKey()) {
  if (!it.adStart && !it.adEnd) return null;
  if (it.adStart && today < it.adStart) return 'scheduled';
  if (it.adEnd && today > it.adEnd) return 'ended';
  return 'active';
}
function adRange(it) {
  const a = it.adStart ? fmtDay(it.adStart) : '…';
  const b = it.adEnd ? fmtDay(it.adEnd) : '…';
  return `${a} – ${b}`;
}

async function refresh({ quiet = false } = {}) {
  if (state.loading || !state.dateField) return;
  state.loading = true;
  $('refreshBtn').classList.add('spin');
  if (!quiet) setStatus('Loading…');
  try {
    await loadIssues();
    render();
    const igCount = state.issues.filter((i) => i.ig).length;
    setStatus(`${state.issues.length} issues`
      + (state.igField ? ` · ${igCount} Instagram` : '')
      + ` · updated ${new Date().toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`);
  } catch (e) {
    console.error(e);
    setStatus('Could not load issues: ' + errText(e), true);
  } finally {
    state.loading = false;
    $('refreshBtn').classList.remove('spin');
  }
}

function dateFieldPayload(key) {
  const f = state.dateField;
  return { name: f.name, $type: f.type === 'date' ? 'DateIssueCustomField' : 'DateTimeIssueCustomField', value: keyToTs(key, f.type) };
}
function valuePayload(f, value) {
  const $type = IG_TYPES[f.type];
  if (!$type) return null;
  return { name: f.name, $type, value: f.type.endsWith('[*]') ? [{ name: value }] : { name: value } };
}
function igFieldPayload() { return valuePayload(state.igField, state.igField.value); }

async function createIssue({ summary, description, key, ig, account }) {
  const customFields = [dateFieldPayload(key)];
  const igp = ig && state.igField ? igFieldPayload() : null;
  if (igp) customFields.push(igp);
  const af = account && account.value && state.accountFields.find((f) => f.name === account.field);
  const accp = af ? valuePayload(af, account.value) : null;
  if (accp) customFields.push(accp);
  const body = { project: { id: state.project.id }, summary, customFields };
  if (description) body.description = description;
  try {
    return await host.fetchYouTrack('issues?fields=id,idReadable', { method: 'POST', body });
  } catch (e) {
    if (!igp && !accp) throw e;
    // If Type / Product can't be set (permissions / field type), still create the issue
    console.warn('Could not set the extra fields, retrying without them', e);
    body.customFields = [dateFieldPayload(key)];
    const res = await host.fetchYouTrack('issues?fields=id,idReadable', { method: 'POST', body });
    toast(`Couldn't set ${[igp && state.igField.name, accp && af.name].filter(Boolean).join(' / ')}; set it on the issue manually`, 6000);
    return res;
  }
}

async function moveIssue(issue, key) {
  return host.fetchYouTrack(`issues/${issue.id}?fields=id`, { method: 'POST', body: { customFields: [dateFieldPayload(key)] } });
}

function uploadName(file, asCover) {
  let name = (file.name || 'image.jpg').replace(/["\r\n]/g, '_');
  if (asCover && !COVER_RE.test(name)) name = 'cover_' + name;
  if (!asCover && COVER_RE.test(name)) name = name.replace(/cover/gi, 'img'); // avoid an accidental cover
  return name;
}

/**
 * Uploads the image as an issue attachment. The Host API JSON-encodes bodies, so the multipart
 * body is built by hand and sent raw. An empty response counts as a failure.
 */
async function uploadImage(issueId, file, { asCover = false } = {}) {
  const name = uploadName(file, asCover);
  /* @preview-start */
  if (IS_PREVIEW) return host.__attach(issueId, file, name);
  /* @preview-end */
  const boundary = '----PostGridPlanner' + Math.random().toString(16).slice(2);
  const headStr = `--${boundary}\r\nContent-Disposition: form-data; name="upload"; filename="${name}"\r\n`
    + `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`;
  const tailStr = `\r\n--${boundary}--\r\n`;
  const ctype = `multipart/form-data; boundary=${boundary}`;
  const url = `issues/${issueId}/attachments?fields=id,name,url`;
  const attempts = [
    async () => new Blob([headStr, file, tailStr], { type: ctype }),
    async () => {
      const enc = new TextEncoder();
      const parts = [enc.encode(headStr), new Uint8Array(await file.arrayBuffer()), enc.encode(tailStr)];
      const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
      let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
      return out.buffer;
    },
  ];
  let lastErr;
  for (const makeBody of attempts) {
    try {
      const res = await host.fetchYouTrack(url, { method: 'POST', body: await makeBody(), sendRawBody: true, headers: { 'Content-Type': ctype } });
      if (Array.isArray(res) && res.length) return res;
      lastErr = new Error('The server did not accept the attachment');
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------- render: feed */

function feedItems() {
  return state.issues
    .filter(inFeed)
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : b.created - a.created));
}

function renderProfile() {
  const p = state.project;
  const acc = state.ui.account;
  const av = $('igAvatar');
  av.style.backgroundImage = ''; av.style.background = '';
  if (acc && acc.value) {
    $('igHandle').textContent = '@' + slug(acc.value);
    $('igName').textContent = acc.value;
    $('igBio').textContent = `${acc.field} · ${p.name}`;
    const h = hue(acc.value);
    av.style.background = `linear-gradient(135deg, hsl(${h} 80% 58%), hsl(${(h + 50) % 360} 75% 45%))`;
    av.textContent = acc.value.trim().slice(0, 1).toUpperCase();
  } else {
    $('igHandle').textContent = acc ? `@no.${slug(acc.field)}` : '@' + (p.shortName || '').toLowerCase();
    $('igName').textContent = acc ? `No ${acc.field}` : p.name;
    $('igBio').textContent = acc ? `Instagram posts without a ${acc.field} · ${p.name}`
      : (p.description || 'Content plan').split('\n').slice(0, 2).join('\n');
    if (p.iconUrl && !/default/i.test(p.iconUrl)) { av.style.backgroundImage = `url("${absUrl(p.iconUrl)}")`; av.textContent = ''; }
    else av.textContent = (p.name || '?').trim().slice(0, 1).toUpperCase();
  }
  renderAccountPicker();
  const items = feedItems();
  const today = todayKey();
  const posts = items.filter((i) => i.images.length).length;
  const planned = items.filter((i) => i.key >= today).length;
  const missing = items.filter((i) => !i.images.length).length;
  $('statPosts').textContent = posts;
  $('statPlanned').textContent = planned;
  $('statMissing').textContent = missing;
  $('igMiniStats').textContent = `${posts} posts · ${planned} scheduled`;
}

/** Instagram-style account switcher on the handle: All accounts + one group per field (Product, Department…). */
function renderAccountPicker() {
  const sel = $('accountSel');
  const has = state.accountFields.length > 0;
  $('acctSwitch').classList.toggle('on', has);
  sel.hidden = !has;
  if (!has) return;
  const igIssues = state.issues.filter((i) => i.ig);
  const cur = state.ui.account;
  const opt = (field, value, label, n) => {
    const v = field ? JSON.stringify([field, value]) : '';
    const selected = cur ? (cur.field === field && cur.value === value) : !field;
    return `<option value="${esc(v)}"${selected ? ' selected' : ''}>${esc(label)}${n != null ? ` (${n})` : ''}</option>`;
  };
  let html = opt(null, null, 'All accounts', igIssues.length);
  for (const f of state.accountFields) {
    html += `<optgroup label="${esc(f.name)}">`;
    for (const v of f.values) html += opt(f.name, v, v, igIssues.filter((i) => inAccount(i, { field: f.name, value: v })).length);
    const none = igIssues.filter((i) => inAccount(i, { field: f.name, value: '' })).length;
    if (none) html += opt(f.name, '', `No ${f.name}`, none);
    html += '</optgroup>';
  }
  sel.innerHTML = html;
}

const ICON_BOOST = '<svg viewBox="0 0 24 24" width="12" height="12"><path d="M4 17l6-6 4 4 6-7M14 8h6v6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_CAROUSEL = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M7 3h11a3 3 0 0 1 3 3v11" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="7" width="14" height="14" rx="2.5" fill="currentColor"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';

function renderGrid() {
  const items = feedItems();
  const today = todayKey();
  const total = Math.max(MIN_TILES, Math.ceil(items.length / 3) * 3);
  let html = '';
  for (let i = 0; i < total; i++) {
    const it = items[i];
    if (!it) { html += '<div class="tile blank" aria-hidden="true"></div>'; continue; }
    const when = fmtDay(it.key);
    const boosted = adStatus(it, today) === 'active';
    const boost = boosted ? `<span class="boost">${ICON_BOOST}<span>Boosted</span></span>` : '';
    const tip = boosted ? ` · Boosted ${adRange(it)}` : '';
    if (it.images.length) {
      const badge = it.images.length > 1 ? ICON_CAROUSEL : it.key > today ? ICON_CLOCK : '';
      html += `<button class="tile${boosted ? ' boosted' : ''}" data-id="${esc(it.id)}" title="${esc(it.summary)} · ${esc(when)}${esc(tip)}">
        <img src="${esc(it.images[0].url)}" alt="${esc(it.summary)}" loading="lazy">
        ${badge ? `<span class="badge">${badge}</span>` : ''}
        <span class="when">${esc(when)}</span><span class="over">${esc(it.summary)}</span>${boost}</button>`;
    } else {
      html += `<button class="tile noimg${boosted ? ' boosted' : ''}" data-id="${esc(it.id)}" data-addimg="1" title="Add image: ${esc(it.summary)} · ${esc(when)}${esc(tip)}">
        <span class="plus">＋</span><span class="t">${esc(it.summary)}</span><span class="when">${esc(when)}</span>${boost}</button>`;
    }
  }
  $('grid').innerHTML = html;
  let hint = '';
  if (!items.length) {
    const acc = state.ui.account;
    hint = acc ? `No Instagram posts for ${acc.value || `"no ${acc.field}"`} yet`
      : state.igField ? `No issues with ${state.igField.name} = "${state.igField.value}"` : 'The grid fills up as you add posts to the calendar';
  }
  else if (items.length > MIN_TILES) hint = `${items.length} posts · scroll down for older ones`;
  $('gridHint').textContent = hint;
  layoutFeed();
}

/** Sizes the grid so exactly 3 columns × 3 rows are visible in the available space; the rest scrolls. */
function layoutFeed() {
  const h = $('app').clientHeight || innerHeight;
  document.body.classList.toggle('compact', h < 640);
  document.body.classList.toggle('tiny', h < 420);

  const area = $('gridArea');
  const vp = $('gridViewport');
  const narrow = matchMedia('(max-width: 760px)').matches;
  const gap = 2, sb = 6;
  const availW = area.clientWidth;
  const availH = narrow ? Infinity : area.clientHeight;
  if (!availW) return;
  let tileW = (availW - sb - gap * 2) / 3;
  let tileH = tileW * 4 / 3;
  if (tileH * 3 + gap * 2 > availH) { tileH = Math.max(24, (availH - gap * 2) / 3); tileW = tileH * 3 / 4; }
  vp.style.width = Math.floor(tileW * 3 + gap * 2 + sb) + 'px';
  // Scrollbar width varies by browser → compute the height from the real column width
  const realW = $('grid').clientWidth || tileW * 3 + gap * 2;
  const realTileH = ((realW - gap * 2) / 3) * 4 / 3;
  vp.style.height = Math.floor(realTileH * 3 + gap * 2) + 'px';
  tileW = (realW - gap * 2) / 3;
  $('grid').querySelectorAll('.tile').forEach((t) => t.classList.toggle('small', tileW < 64));
}

/* ---------------------------------------------------------------- render: calendar */

function weekdayNames() {
  const base = new Date(2024, 0, 1); // a Monday
  return Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(LOCALE, { weekday: 'short' }).format(new Date(base.getTime() + i * 864e5)));
}

function calendarIssues() {
  return state.ui.onlyIG ? state.issues.filter(inFeed) : state.issues;
}
function issuesOn(key) {
  return calendarIssues().filter((i) => i.key === key).sort((a, b) => (inFeed(b) - inFeed(a)) || (a.created - b.created));
}

function renderCalendar() {
  const c = state.cursor;
  $('monthLabel').textContent = new Intl.DateTimeFormat(LOCALE, { month: 'long', year: 'numeric' }).format(c);
  $('weekdays').innerHTML = weekdayNames().map((n) => `<div>${esc(n)}</div>`).join('');

  const byDay = new Map();
  for (const it of calendarIssues()) {
    if (!byDay.has(it.key)) byDay.set(it.key, []);
    byDay.get(it.key).push(it);
  }
  for (const arr of byDay.values()) arr.sort((a, b) => (inFeed(b) - inFeed(a)) || (a.created - b.created));

  const first = new Date(c.getFullYear(), c.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(first); start.setDate(1 - offset);
  const lastOfMonth = new Date(c.getFullYear(), c.getMonth() + 1, 0);
  const rows = Math.ceil((offset + lastOfMonth.getDate()) / 7);
  const today = todayKey();

  // Cell height → how many posts fit
  const grid = $('calGrid');
  const fit = state.ui.size === 'fit';
  grid.classList.toggle('fit', fit);
  grid.classList.toggle('fixed', !fit);
  grid.style.setProperty('--rows', rows);
  grid.style.setProperty('--rowH', (fit ? 120 : Number(state.ui.size)) + 'px');
  const cellH = fit ? ($('calBody').clientHeight - 1) / rows - 1 : Number(state.ui.size) - 1;
  const fitChips = Math.max(0, Math.floor((cellH - 6 - 20 - 3) / 23));

  let html = '';
  for (let i = 0; i < rows * 7; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const key = keyOfDate(d);
    const out = d.getMonth() !== c.getMonth();
    const list = byDay.get(key) || [];
    let shown = list;
    let moreBtn = '';
    let countBadge = '';
    if (list.length > fitChips) {
      if (fitChips <= 0) {
        shown = [];
        const igN = list.filter((x) => x.ig).length;
        countBadge = `<button class="count${igN ? '' : ' plain'}" data-more="${key}" title="${list.length} posts">${list.length}</button>`;
      } else {
        shown = list.slice(0, fitChips - 1);
        moreBtn = `<button class="more" data-more="${key}">+${list.length - shown.length} more</button>`;
      }
    }
    html += `<div class="day${out ? ' out' : ''}${key === today ? ' today' : ''}" data-key="${key}">
      <div class="day-head"><span class="dnum">${d.getDate()}</span>${countBadge}
        <button class="add" data-add="${key}" title="Add a post on ${esc(fmtDay(key, { day: 'numeric', month: 'long' }))}">+</button></div>
      ${shown.map(chipHtml).join('')}${moreBtn}
    </div>`;
  }
  grid.innerHTML = html;
}

function chipHtml(it) {
  const thumb = it.images.length
    ? `<img class="thumb" src="${esc(it.images[0].thumb)}" alt="">`
    : '<span class="thumb none" title="No image">＋</span>';
  const dot = it.state ? `<span class="dot" title="${esc(it.state)}" style="${it.stateColor ? `background:${esc(it.stateColor)}` : ''}"></span>` : '';
  const filtering = state.igField || state.ui.account;
  const cls = ['chip', it.resolved && 'resolved', filtering && (inFeed(it) ? 'ig' : 'other')].filter(Boolean).join(' ');
  const acct = accountLabel(it);
  return `<div class="${cls}" draggable="true" data-id="${esc(it.id)}" title="${esc(it.idReadable)} · ${esc(it.summary)}${it.ig && state.igField ? ' · Instagram' : ''}${acct ? ' · ' + esc(acct) : ''}">
    ${thumb}<span class="s">${esc(it.summary)}</span>${adStatus(it) === 'active' ? '<span class="ad" title="Boosted ' + esc(adRange(it)) + '">Ad</span>' : ''}${dot}</div>`;
}

function render() {
  renderProfile();
  renderGrid();
  renderCalendar();
}

/* ---------------------------------------------------------------- setup / controls */

function renderControls() {
  const pill = $('fieldPill');
  if (state.dateFields.length > 1) {
    pill.innerHTML = `<select id="fieldSel" aria-label="Date field">${state.dateFields
      .map((f) => `<option${f.name === state.dateField.name ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}</select>`;
    $('fieldSel').addEventListener('change', async (e) => {
      state.dateField = state.dateFields.find((f) => f.name === e.target.value);
      await storageSet(`postDateField:${entity.id}`, state.dateField.name);
      refresh();
    });
  } else pill.textContent = state.dateField ? state.dateField.name : '';

  $('igToggleWrap').hidden = !state.igField && !state.accountFields.length;
  $('igToggle').checked = state.ui.onlyIG;
  $('sizeSel').value = state.ui.size;
  if (state.igField) $('fIgLabel').textContent = `${state.igField.name}: ${state.igField.value}`;
  renderSetupBanner();
}

/** Points to Project Settings → Post Grid Planner when the planner's fields are missing. */
async function renderSetupBanner() {
  const missing = [];
  if (!state.dateFields.some((f) => /^publish\s*date$/i.test(f.name))) missing.push('Publish Date');
  if (!state.igField) missing.push('"Instagram Post" in Type');
  const key = `setupBanner:${entity.id}:${missing.join('|')}`;
  const blocking = !state.dateField;   // nothing can be planned without a date field, so this one can't be dismissed
  if (!missing.length || (!blocking && (await storageGet(key)) === 'dismissed')) { $('setupBanner').hidden = true; return; }
  $('setupText').innerHTML = `<b>Finish setup.</b> Missing: ${esc(missing.join(', '))}. `
    + 'A project admin can add everything in one step: <b>Project Settings → Post Grid Planner → Set up</b>. '
    + 'No access to Settings? Ask your project admin.'
    + (!blocking && !state.igField ? ' Until then the grid shows every issue that has a date.' : '')
    + (!state.accountFields.length ? ' Optional: add Product names there to switch between Instagram accounts.' : '');
  $('setupClose').hidden = blocking;
  $('setupBanner').hidden = false;
  $('setupClose').onclick = () => { $('setupBanner').hidden = true; storageSet(key, 'dismissed'); };
}

/**
 * App height: the user's value if set; otherwise the default, or the whole frame if YouTrack
 * gave a bigger one. The height comes from the content, so the frame follows it.
 */
function applyAppHeight() {
  let h = state.ui.appH || DEFAULT_APP_H;
  if (!state.ui.appH && innerHeight > h + 2 && !matchMedia('(max-width: 760px)').matches) h = innerHeight;
  document.documentElement.style.setProperty('--appH', Math.round(h) + 'px');
}

function applyFeedWidth() {
  document.documentElement.style.setProperty('--feedW', state.ui.feedW + 'px');
}

/* ---------------------------------------------------------------- dialog */

function openModal(key, issue = null) {
  closePopover(); closeDayPop();
  state.editingIssue = issue;
  state.pendingFile = null;
  $('modalTitle').textContent = issue ? `Add image · ${issue.idReadable}` : 'New post';
  $('fSummary').value = issue ? issue.summary : '';
  $('fSummary').disabled = !!issue;
  $('fDate').value = issue ? issue.key : (key || todayKey());
  $('fDate').disabled = !!issue;
  $('fDesc').value = '';
  $('fDescWrap').hidden = !!issue;
  $('fIgWrap').hidden = !!issue || !state.igField;
  $('fIg').checked = true;
  // Account: preselect the account the feed is showing
  const fa = $('fAccount');
  $('fAccountWrap').hidden = !!issue || !state.accountFields.length;
  if (state.accountFields.length) {
    const cur = state.ui.account;
    fa.innerHTML = '<option value="">— none —</option>' + state.accountFields.map((f) => `<optgroup label="${esc(f.name)}">${
      f.values.map((v) => `<option value="${esc(JSON.stringify([f.name, v]))}"${cur && cur.field === f.name && cur.value === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</optgroup>`).join('');
  }
  // A post without images: the first image becomes the cover. Adding to a carousel: not by default.
  $('fCover').checked = !issue || !issue.images.length;
  setPreview(null);
  $('modal').hidden = false;
  setTimeout(() => (issue ? $('drop') : $('fSummary')).focus(), 0);
}
function closeModal() {
  if (state.saving) return;
  $('modal').hidden = true; state.editingIssue = null; state.pendingFile = null;
}

function setPreview(file) {
  const img = $('dropPreview');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  if (!file) { img.hidden = true; img.removeAttribute('src'); delete img.dataset.url; $('dropText').innerHTML = 'Drop, paste or <u>browse</u> an image'; return; }
  const u = URL.createObjectURL(file);
  img.src = u; img.dataset.url = u; img.hidden = false;
  $('dropText').textContent = file.name + ' · change';
}
function acceptFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Please choose an image file'); return; }
  state.pendingFile = file;
  setPreview(file);
}

async function save() {
  if (state.saving) return;
  const btn = $('saveBtn');
  const file = state.pendingFile;
  const isNew = !state.editingIssue;
  let target = state.editingIssue;

  // Manual validation (no <form> in the sandbox)
  if (isNew) {
    if (!$('fSummary').value.trim()) { toast('Enter a title'); $('fSummary').focus(); return; }
    if (!$('fDate').value) { toast('Pick a date'); $('fDate').focus(); return; }
  } else if (!file) {
    toast('Choose an image first');
    return;
  }

  state.saving = true;
  btn.disabled = true;
  try {
    if (isNew) {
      const summary = $('fSummary').value.trim();
      const key = $('fDate').value;
      btn.textContent = 'Creating issue…';
      let account = null;
      try { const v = $('fAccount').value; if (v) { const [field, value] = JSON.parse(v); account = { field, value }; } } catch { /* none */ }
      const created = await createIssue({ summary, description: $('fDesc').value.trim(), key, ig: $('fIg').checked, account });
      target = { id: created.id, idReadable: created.idReadable, summary };
      const [y, m] = key.split('-').map(Number);
      state.cursor = new Date(y, m - 1, 1);
    }
    if (file) {
      btn.textContent = 'Uploading image…';
      try {
        await uploadImage(target.id, file, { asCover: $('fCover').checked });
      } catch (err) {
        console.error(err);
        toast(`${isNew ? `${target.idReadable} was created, but the` : 'The'} image couldn't be uploaded (${errText(err)}). `
          + 'You can drag the image onto the issue in YouTrack.', 9000);
      }
    }
    state.saving = false;
    closeModal();
    await refresh({ quiet: true });
    flashTile(target.id);
    if (isNew) toast(`${target.idReadable} created`);
  } catch (err) {
    console.error(err);
    toast('Could not save: ' + errText(err), 8000);
  } finally {
    state.saving = false;
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

function flashTile(id) {
  const el = $('grid').querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

/* ---------------------------------------------------------------- popovers */

function placeNear(pop, anchor) {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = r.right + 8;
  if (left + pw > innerWidth - 8) left = r.left - pw - 8;
  if (left < 8) left = Math.max(8, Math.min(innerWidth - pw - 8, r.left));
  const top = Math.max(8, Math.min(r.top, innerHeight - ph - 8));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function openPopover(issue, anchor) {
  const img = $('popImg');
  if (issue.images.length) { img.src = issue.images[0].url; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  $('popId').textContent = [issue.idReadable, issue.state, issue.ig && state.igField ? 'Instagram' : null, accountLabel(issue) || null,
    issue.images.length > 1 ? `${issue.images.length} images` : null].filter(Boolean).join(' · ');
  $('popTitle').textContent = issue.summary;
  $('popDate').textContent = fmtDay(issue.key, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const ad = adStatus(issue);
  const popAd = $('popAd');
  popAd.className = 'pop-ad' + (ad ? ' ' + ad : '');
  popAd.textContent = !ad ? '' : ad === 'active' ? `Boosted · ${adRange(issue)}`
    : ad === 'scheduled' ? `Ad scheduled · ${adRange(issue)}` : `Ad ended · ${adRange(issue)}`;
  const cov = issue.images[0];
  $('popCover').textContent = issue.images.length > 1
    ? (cov.coverBy === 'name' ? `Cover: ${cov.name}`
      : cov.coverBy === 'comment' ? `Cover: ${cov.name} (marked in a comment)`
        : 'Cover: first image (none marked "cover")')
    : '';
  $('popAddImg').textContent = issue.images.length ? 'Add image (carousel)' : 'Add image';
  $('popAddImg').onclick = () => openModal(null, issue);
  $('popOpen').href = issueUrl(issue);
  $('popOpen').hidden = IS_PREVIEW;
  placeNear($('popover'), anchor);
}
function closePopover() { $('popover').hidden = true; }

function openDayPop(key, anchor) {
  closePopover();
  $('dayPopTitle').textContent = fmtDay(key, { weekday: 'long', day: 'numeric', month: 'long' });
  $('dayPopList').innerHTML = issuesOn(key).map(chipHtml).join('');
  $('dayPopAdd').onclick = () => openModal(key);
  placeNear($('dayPop'), anchor);
}
function closeDayPop() { $('dayPop').hidden = true; }

/* ---------------------------------------------------------------- events */

function findIssue(id) { return state.issues.find((i) => i.id === id); }

function bindEvents() {
  $('prevBtn').onclick = () => { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() - 1, 1); renderCalendar(); };
  $('nextBtn').onclick = () => { state.cursor = new Date(state.cursor.getFullYear(), state.cursor.getMonth() + 1, 1); renderCalendar(); };
  $('todayBtn').onclick = () => { state.cursor = startOfMonth(new Date()); renderCalendar(); };
  $('newBtn').onclick = () => openModal(todayKey());
  $('refreshBtn').onclick = () => refresh();
  $('cancelBtn').onclick = closeModal;
  $('saveBtn').onclick = save;
  $('fSummary').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); closePopover(); closeDayPop(); } });

  $('sizeSel').addEventListener('change', (e) => { state.ui.size = e.target.value; saveUi(); renderCalendar(); });
  $('accountSel').addEventListener('change', (e) => {
    try { const [field, value] = JSON.parse(e.target.value || 'null') || []; state.ui.account = field ? { field, value } : null; }
    catch { state.ui.account = null; }
    saveUi();
    closePopover(); closeDayPop();
    $('gridViewport').scrollTop = 0;
    render();
  });
  $('igToggle').addEventListener('change', (e) => { state.ui.onlyIG = e.target.checked; saveUi(); renderCalendar(); });

  // Image pick / drag & drop / paste (dialog)
  const drop = $('drop');
  $('fFile').addEventListener('change', (e) => acceptFile(e.target.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); acceptFile(e.dataTransfer.files[0]); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fFile').click(); } });
  drop.tabIndex = 0;
  document.addEventListener('paste', (e) => {
    if ($('modal').hidden) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) acceptFile(f);
  });

  // Calendar + day list clicks
  const onCalClick = (e) => {
    const add = e.target.closest('[data-add]');
    if (add) { openModal(add.dataset.add); return; }
    const chip = e.target.closest('.chip');
    if (chip) { const it = findIssue(chip.dataset.id); if (it) openPopover(it, chip); return; }
    const more = e.target.closest('[data-more]');
    if (more) { openDayPop(more.dataset.more, more.closest('.day') || more); return; }
    const day = e.target.closest('.day');
    if (day && e.detail === 2) openModal(day.dataset.key);
  };
  $('calGrid').addEventListener('click', onCalClick);
  $('dayPopList').addEventListener('click', onCalClick);

  // Drag a post to another day to reschedule it
  let dragId = null;
  const onDragStart = (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    dragId = chip.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
    closePopover();
    setTimeout(closeDayPop, 0);
  };
  $('calGrid').addEventListener('dragstart', onDragStart);
  $('dayPopList').addEventListener('dragstart', onDragStart);
  $('calGrid').addEventListener('dragover', (e) => {
    const day = e.target.closest('.day');
    if (!day) return;
    e.preventDefault();
    $('calGrid').querySelectorAll('.drop-target').forEach((d) => d !== day && d.classList.remove('drop-target'));
    day.classList.add('drop-target');
  });
  $('calGrid').addEventListener('dragleave', (e) => {
    const day = e.target.closest('.day');
    if (day && !day.contains(e.relatedTarget)) day.classList.remove('drop-target');
  });
  $('calGrid').addEventListener('drop', async (e) => {
    const day = e.target.closest('.day');
    if (!day) return;
    e.preventDefault();
    day.classList.remove('drop-target');
    const file = [...(e.dataTransfer.files || [])].find((f) => f.type.startsWith('image/'));
    if (file && !dragId) { openModal(day.dataset.key); acceptFile(file); return; }
    const it = dragId && findIssue(dragId);
    dragId = null;
    if (!it || it.key === day.dataset.key) return;
    const oldKey = it.key;
    it.key = day.dataset.key;
    render();
    try {
      await moveIssue(it, it.key);
      toast(`${it.idReadable} → ${fmtDay(it.key, { day: 'numeric', month: 'long' })}`);
      flashTile(it.id);
    } catch (err) {
      console.error(err);
      it.key = oldKey; render();
      toast('Could not change the date: ' + errText(err), 6000);
    }
  });
  document.addEventListener('dragend', () => { dragId = null; });

  // Grid clicks
  $('grid').addEventListener('click', (e) => {
    const tile = e.target.closest('.tile[data-id]');
    if (!tile) return;
    const it = findIssue(tile.dataset.id);
    if (!it) return;
    if (tile.dataset.addimg) { state.editingIssue = it; $('quickFile').value = ''; $('quickFile').click(); return; }
    const [y, m] = it.key.split('-').map(Number);
    state.cursor = new Date(y, m - 1, 1);
    renderCalendar();
    const chip = $('calGrid').querySelector(`.chip[data-id="${CSS.escape(it.id)}"]`);
    openPopover(it, chip || tile);
  });
  $('quickFile').addEventListener('change', async (e) => {
    const it = state.editingIssue;
    const file = e.target.files[0];
    state.editingIssue = null;
    if (!it || !file) return;
    toast('Uploading image…', 10000);
    try {
      await uploadImage(it.id, file, { asCover: true });
      await refresh({ quiet: true });
      flashTile(it.id);
      toast('Image added');
    } catch (err) {
      console.error(err);
      toast(`The image couldn't be uploaded (${errText(err)}). You can drag it onto the issue in YouTrack.`, 9000);
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('#popover, #dayPop, .chip, .tile, [data-more], #modal')) return;
    closePopover(); closeDayPop();
  });
  $('gridViewport').addEventListener('scroll', closePopover, { passive: true });

  // Feed width: drag the splitter
  const sp = $('splitter');
  const clampW = (w) => Math.round(Math.max(180, Math.min(w, innerWidth * 0.65)));
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    sp.classList.add('dragging'); document.body.classList.add('resizing');
    const startX = e.clientX, startW = $('feedPanel').offsetWidth;
    const move = (ev) => { state.ui.feedW = clampW(startW + ev.clientX - startX); applyFeedWidth(); };
    const up = () => {
      sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up);
      sp.classList.remove('dragging'); document.body.classList.remove('resizing');
      saveUi();
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
  sp.addEventListener('dblclick', () => { state.ui.feedW = DEFAULT_FEED_W; applyFeedWidth(); saveUi(); });
  sp.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0;
    if (!d) return;
    e.preventDefault(); state.ui.feedW = clampW($('feedPanel').offsetWidth + d); applyFeedWidth(); saveUi();
  });

  // Height: drag the bottom edge
  const vr = $('vresize');
  vr.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    vr.setPointerCapture(e.pointerId);
    vr.classList.add('dragging'); document.body.classList.add('vresizing');
    const startY = e.clientY, startH = $('app').offsetHeight;
    const move = (ev) => { state.ui.appH = Math.max(MIN_APP_H, Math.min(4000, startH + ev.clientY - startY)); applyAppHeight(); };
    const up = () => {
      vr.removeEventListener('pointermove', move); vr.removeEventListener('pointerup', up);
      vr.classList.remove('dragging'); document.body.classList.remove('vresizing');
      saveUi();
    };
    vr.addEventListener('pointermove', move);
    vr.addEventListener('pointerup', up);
  });
  vr.addEventListener('dblclick', () => { state.ui.appH = null; applyAppHeight(); saveUi(); });
  vr.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowUp' ? -40 : e.key === 'ArrowDown' ? 40 : 0;
    if (!d) return;
    e.preventDefault(); state.ui.appH = Math.max(MIN_APP_H, $('app').offsetHeight + d); applyAppHeight(); saveUi();
  });
  addEventListener('resize', applyAppHeight);

  // On resize: re-layout the grid and calendar cells
  let raf = 0;
  const relayout = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      layoutFeed();
      if (state.project) renderCalendar();
      if (statusMsg && !$('status').classList.contains('err')) setStatus(statusMsg);
    });
  };
  new ResizeObserver(relayout).observe($('calBody'));
  new ResizeObserver(relayout).observe($('gridArea'));
}

/* ---------------------------------------------------------------- boot */

async function boot() {
  if (!host) {
    setStatus('Open this tab inside YouTrack.', true);
    return;
  }
  try { Object.assign(state.ui, JSON.parse((await storageGet('ui')) || '{}')); } catch { /* ignore */ }
  applyFeedWidth();
  applyAppHeight();
  bindEvents();
  try {
    await loadProject();
  } catch (e) {
    console.error(e);
    setStatus('Could not read the project: ' + errText(e), true);
    return;
  }
  if (!state.dateField) {
    // No date field yet: show the empty calendar and grid with a setup hint instead of a blank page
    renderControls();
    render();
    $('newBtn').disabled = true;
    $('newBtn').title = 'Add a Publish Date field first (Project Settings → Post Grid Planner)';
    setStatus('No date field in this project yet.');
    return;
  }
  renderControls();
  await refresh();
  setInterval(() => { if (document.visibilityState === 'visible' && $('modal').hidden) refresh({ quiet: true }); }, AUTO_REFRESH_MS);
  /* @preview-start */
  if (IS_PREVIEW) setStatus('Preview mode · sample data');
  /* @preview-end */
}

boot();

/* @preview-start — removed from the release build by build.py */
/* ---------------------------------------------------------------- preview (outside YouTrack) */

function createMockHost() {
  const palette = [
    ['#6f4e37', '#c8a27a'], ['#2d1e17', '#a0522d'], ['#d9b48f', '#f3e5d0'], ['#8a5a44', '#e8c39e'],
    ['#3b2f2f', '#b5835a'], ['#c19a6b', '#fff3e0'], ['#4e342e', '#d7ccc8'], ['#5d4037', '#ffab91'],
    ['#795548', '#ffe0b2'], ['#263238', '#90a4ae'], ['#bf360c', '#ffccbc'], ['#33691e', '#dcedc8'],
  ];
  const makeImg = (i, label) => {
    const c = document.createElement('canvas'); c.width = 360; c.height = 480;
    const g = c.getContext('2d');
    const [a, b] = palette[i % palette.length];
    const gr = g.createLinearGradient(0, 0, 360, 480); gr.addColorStop(0, a); gr.addColorStop(1, b);
    g.fillStyle = gr; g.fillRect(0, 0, 360, 480);
    g.globalAlpha = .18; g.fillStyle = '#fff';
    for (let k = 0; k < 5; k++) { g.beginPath(); g.arc(60 + ((i * 97 + k * 131) % 260), 70 + ((i * 53 + k * 177) % 360), 30 + ((i + k) * 23) % 70, 0, 7); g.fill(); }
    g.globalAlpha = 1; g.fillStyle = '#fff'; g.font = 'bold 26px system-ui, sans-serif'; g.textAlign = 'center';
    g.fillText(label, 180, 250);
    return c.toDataURL('image/jpeg', .8);
  };
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const at = (dd) => Date.UTC(y, m, dd, 12);
  // [day, title, image count, is instagram]
  const seed = [
    [2, 'Bring a friend', 1, 1], [3, 'Blog: coffee guide', 0, 0], [5, 'Hiring a barista', 1, 1], [5, 'Newsletter draft', 0, 0],
    [9, 'We love you', 1, 1], [11, 'New season, new menu', 2, 1], [11, 'Press release', 0, 0], [11, 'LinkedIn announcement', 0, 0],
    [14, 'Runners, listen up!', 1, 1], [16, 'Keep on sharing', 1, 1], [18, 'Yesterday was so much fun', 2, 1], [20, 'Happy Sunday', 1, 1],
    [22, 'Smile, it\'s Friday', 0, 1], [25, 'Work with us', 1, 1], [27, 'Winter latte', 1, 1], [29, 'Bean story', 0, 1], [30, 'Month-end coffee', 1, 1],
  ];
  // issue index → [ad start day, ad end day] (relative to the current month)
  const td = now.getDate();
  const AD = { 0: [2, td + 3], 4: [td, td + 7], 2: [5, Math.max(1, td - 2)], 8: [td + 4, td + 10] };
  let n = 0;
  const issues = seed.map(([d, s, imgs, ig], i) => {
    const attachments = Array.from({ length: imgs }, (_, k) => ({
      id: `a${++n}`, name: i === 5 && k === 1 ? 'cover_menu.jpg' : `img${k}.png`, mimeType: 'image/jpeg',
      url: makeImg(i * 2 + k, k ? s + ' (2)' : s), created: k,
    }));
    // "Yesterday…": second image marked as cover through a comment
    const comments = i === 10 ? [{ text: 'cover ![](img1.png)', deleted: false, attachments: [{ id: attachments[1].id }] }] : [];
    return {
      id: `2-${i + 1}`, idReadable: `PM-${i + 1}`, summary: s, created: Date.now() - (100 - i) * 1e6,
      resolved: at(d) < Date.now() - 864e5 ? Date.now() : null,
      customFields: [
        { name: 'Publish Date', value: at(d) },
        { name: 'Ad Start Date', value: AD[i] ? at(AD[i][0]) : null },
        { name: 'Ad End Date', value: AD[i] ? at(AD[i][1]) : null },
        { name: 'State', value: { name: at(d) < Date.now() ? 'Done' : 'Planned', color: { background: at(d) < Date.now() ? '#22c55e' : '#a855f7' } } },
        { name: 'Type', value: { name: ig ? 'Instagram Post' : 'Task' } },
        { name: 'Product', value: i === 16 ? null : { name: ['Cortado Coffee', 'Runners Club', 'Cortado Coffee'][i % 3] } },
      ],
      attachments, comments,
    };
  });
  const delay = (v) => new Promise((r) => setTimeout(() => r(structuredClone(v)), 100));
  const store = new Map();
  return {
    storage: { getItem: async (k) => store.get(k) ?? null, setItem: async (k, v) => { store.set(k, v); } },
    async fetchYouTrack(url, params = {}) {
      if (/^admin\/projects\/[^/?]+\?/.test(url)) return delay({ id: '0-1', name: 'Product Marketing', shortName: 'PM', description: 'Content plan', iconUrl: null });
      if (url.startsWith('admin/') && url.includes('/customFields') && /nonadmin/.test(location.search)) return delay([]);
      if (url.startsWith('issues?') && url.includes('projectCustomField')) {
        const types = { 'Publish Date': 'date', 'Ad Start Date': 'date', 'Ad End Date': 'date', Type: 'enum[1]', Product: 'enum[1]', State: 'state[1]' };
        return delay(issues.map((it) => ({ customFields: it.customFields.map((c) => ({
          name: c.name, value: c.value,
          $type: types[c.name] === 'date' ? 'DateIssueCustomField' : c.name === 'State' ? 'StateIssueCustomField' : 'SingleEnumIssueCustomField',
          // Bundles are hidden for Product here, to test the "values seen on issues" fallback
          projectCustomField: { field: { name: c.name, fieldType: { id: types[c.name] } },
            bundle: c.name === 'Type' ? { values: [{ name: 'Task' }, { name: 'Instagram Post' }] } : undefined },
        })) })));
      }
      if (url.startsWith('admin/') && url.includes('/customFields') && /nodate/.test(location.search)) return delay([
        { field: { name: 'Type', fieldType: { id: 'enum[1]' } }, bundle: { values: [{ name: 'Bug' }, { name: 'Task' }] } },
      ]);
      if (url.startsWith('admin/') && url.includes('/customFields')) return delay([
        { field: { name: 'Due Date', fieldType: { id: 'date' } } },
        { field: { name: 'Ad Start Date', fieldType: { id: 'date' } } },
        { field: { name: 'Publish Date', fieldType: { id: 'date' } } },
        { field: { name: 'Ad End Date', fieldType: { id: 'date' } } },
        { field: { name: 'State', fieldType: { id: 'state[1]' } }, bundle: { values: [{ name: 'Planned' }, { name: 'Done' }] } },
        { field: { name: 'Type', fieldType: { id: 'enum[1]' } }, bundle: { values: [{ name: 'Task' }, { name: 'Instagram Post' }, { name: 'Blog' }] } },
        { field: { name: 'Product', fieldType: { id: 'enum[1]' } }, bundle: { values: [{ name: 'Cortado Coffee' }, { name: 'Runners Club' }, { name: 'Bean Box' }] } },
      ]);
      if (url.startsWith('issues?') && params.method === 'POST') {
        const id = `2-${issues.length + 1}`;
        const typeCf = params.body.customFields.find((c) => c.name === 'Type');
        const prodCf = params.body.customFields.find((c) => c.name === 'Product');
        const it = { id, idReadable: `PM-${issues.length + 1}`, summary: params.body.summary, created: Date.now(), resolved: null,
          customFields: [{ name: 'Publish Date', value: params.body.customFields[0].value }, { name: 'State', value: { name: 'Idea', color: { background: '#f59e0b' } } },
            { name: 'Type', value: typeCf ? typeCf.value : { name: 'Task' } }, { name: 'Product', value: prodCf ? prodCf.value : null }], attachments: [], comments: [] };
        issues.push(it);
        return delay({ id, idReadable: it.idReadable });
      }
      if (url.startsWith('issues?')) return delay(issues);
      const mv = url.match(/^issues\/([^/?]+)\?/);
      if (mv && params.method === 'POST') {
        const it = issues.find((x) => x.id === mv[1]);
        it.customFields[0].value = params.body.customFields[0].value;
        return delay({ id: it.id });
      }
      throw new Error('mock: ' + url);
    },
    async __attach(issueId, file, name = file.name) {
      const it = issues.find((x) => x.id === issueId);
      const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
      it.attachments.push({ id: 'a' + (++n), name, mimeType: file.type, url, created: Date.now() });
      return [{ id: 'a' + n }];
    },
  };
}
/* @preview-end */
