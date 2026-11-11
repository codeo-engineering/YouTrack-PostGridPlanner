/* Post Grid Planner — project setup (PROJECT_SETTINGS widget)
 *
 * Checks the project for the fields the planner uses and, after the admin confirms, adds what's missing:
 *   - Publish Date (date)                post date
 *   - Type: "Instagram Post" value       marks Instagram posts
 *   - Ad Start Date / Ad End Date (date) optional, "Boosted" label
 *   - Product (enum) or values for an existing Product / Department field   optional, account switcher
 *
 * Only YouTrack REST API calls as the signed-in user. Nothing is sent outside YouTrack.
 */

const POST_DATE = 'Publish Date';
const AD_START = 'Ad Start Date';
const AD_END = 'Ad End Date';
const IG_VALUE = 'Instagram Post';
const TYPE_NAMES = ['Type', 'Tür', 'Tip'];
const PRODUCT_FIELD = 'Product';
// Same rules the planner uses to find fields
const IG_VALUE_RE = /instagram\s*post/i;
const AD_START_RE = /\bad\b.*start|reklam.*ba[şs]la/i;
const AD_END_RE = /\bad\b.*end|reklam.*bit/i;
const ACCOUNT_FIELD_RE = /product|department|brand|account|ürün|departman|marka/i;

const DATE_TYPES = ['date', 'date and time'];
// ProjectCustomField $type → bundle kind in /api/admin/customFieldSettings/bundles/{kind}
const BUNDLE_KIND = {
  EnumProjectCustomField: 'enum',
  OwnedProjectCustomField: 'ownedField',
  StateProjectCustomField: 'state',
  VersionProjectCustomField: 'version',
  BuildProjectCustomField: 'build',
};

const IS_PREVIEW = typeof window.YTApp === 'undefined';
const host = IS_PREVIEW ? (typeof createSetupMock === 'function' ? createSetupMock() : null) : await window.YTApp.register();
const entity = IS_PREVIEW ? { id: '0-1' } : window.YTApp.entity;

const $ = (id) => document.getElementById(id);

/**
 * Native controls (date picker, selects, scrollbars) follow the YouTrack theme, not the OS theme:
 * read the page background that comes from Ring UI's variables and set color-scheme to match.
 * Re-checked whenever YouTrack changes the theme classes or styles in the frame.
 */
function syncColorScheme() {
  const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
  let dark = false;
  if (m && m.length >= 3 && !(m.length > 3 && Number(m[3]) === 0)) {
    const [r, g, b] = m.map(Number);
    dark = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
  }
  const scheme = dark ? 'dark' : 'light';
  const root = document.documentElement;
  if (root.style.colorScheme !== scheme) root.style.colorScheme = scheme;
  if (root.dataset.theme !== scheme) root.dataset.theme = scheme;
}
syncColorScheme();
{
  const themeObserver = new MutationObserver(syncColorScheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  themeObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
}
const st = { project: null, fields: [], globals: null, items: [], account: null, busy: false };

/* ---------------------------------------------------------------- helpers */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function errText(e) {
  return e?.data?.error_description || e?.data?.error || e?.message || String(e);
}
const same = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const get = (url) => host.fetchYouTrack(url);
const post = (url, body) => host.fetchYouTrack(url, { method: 'POST', body });

function setStatus(msg, err = false) {
  $('status').textContent = msg || '';
  $('status').classList.toggle('err', err);
}

/* ---------------------------------------------------------------- read */

async function load() {
  st.project = await get(`admin/projects/${entity.id}?fields=id,name,shortName`);
  const raw = await get(`admin/projects/${entity.id}/customFields?fields=id,$type,field(id,name,fieldType(id)),`
    + 'bundle(id,name,$type,values(id,name,archived))&$top=500');
  st.fields = (raw || []).map((pf) => ({
    id: pf.id, $type: pf.$type, name: pf.field?.name, fieldId: pf.field?.id, type: pf.field?.fieldType?.id,
    bundle: pf.bundle ? { id: pf.bundle.id, name: pf.bundle.name, $type: pf.bundle.$type, values: pf.bundle.values || [] } : null,
  }));
  // Global field list lets us reuse existing fields instead of creating duplicates.
  // Users without access to it can still attach fields that we create.
  try {
    st.globals = await get('admin/customFieldSettings/customFields?fields=id,name,fieldType(id),'
      + 'fieldDefaults(bundle(id,name,$type))&$top=2000');
  } catch { st.globals = null; }
}

function projectField(test) { return st.fields.find(test) || null; }

function analyze() {
  const items = [];

  const pub = projectField((f) => same(f.name, POST_DATE) && DATE_TYPES.includes(f.type));
  items.push({
    key: 'publish', title: POST_DATE, optional: false,
    desc: 'The day a post goes live. It sets the post\'s place in the grid and the calendar.',
    status: pub ? 'ok' : 'todo', tag: pub ? 'Ready' : 'Will be added',
  });

  const typeField = projectField((f) => TYPE_NAMES.some((n) => same(f.name, n)));
  const typeItem = { key: 'type', title: `Type: ${IG_VALUE}`, optional: false, desc: 'Marks which issues are Instagram posts. Only these appear in the grid.' };
  if (typeField) {
    const v = typeField.bundle?.values.find((x) => IG_VALUE_RE.test(x.name));
    if (v && !v.archived) Object.assign(typeItem, { status: 'ok', tag: 'Ready', desc: `The ${typeField.name} field has "${v.name}".` });
    else if (!BUNDLE_KIND[typeField.$type] || !typeField.bundle) {
      Object.assign(typeItem, { status: 'warn', tag: 'Manual step', desc: `${typeField.name} can't be changed from here. Add "${IG_VALUE}" to it in Project Settings → Fields.` });
    } else {
      Object.assign(typeItem, {
        status: 'todo', tag: v ? 'Will be restored' : 'Will be added', field: typeField, value: v || null,
        desc: v ? `"${v.name}" is archived in ${typeField.name}; it will be restored.` : `"${IG_VALUE}" will be added to the ${typeField.name} field.`,
      });
    }
  } else {
    const gType = st.globals?.find((g) => same(g.name, 'Type') && g.fieldType?.id?.startsWith('enum') && g.fieldDefaults?.bundle?.id);
    if (gType) {
      Object.assign(typeItem, { status: 'todo', tag: 'Will be added', global: gType,
        desc: `The Type field will be added to this project with "${IG_VALUE}".` });
    } else {
      Object.assign(typeItem, { status: 'warn', tag: 'Manual step',
        desc: 'This project has no Type field. Add one in Project Settings → Fields, then click Check again.' });
    }
  }
  items.push(typeItem);

  for (const [key, name, re] of [['adStart', AD_START, AD_START_RE], ['adEnd', AD_END, AD_END_RE]]) {
    const f = projectField((x) => re.test(x.name) && DATE_TYPES.includes(x.type));
    items.push({
      key, title: f ? f.name : name, optional: true, checked: true,
      desc: key === 'adStart' ? 'Optional. With Ad End Date, a blue Boosted label shows while the ad runs.' : 'Optional. Last day of the ad.',
      status: f ? 'ok' : 'todo', tag: f ? 'Ready' : 'Will be added',
    });
  }
  st.items = items;

  // Account field (Product / Department …)
  st.account = projectField((f) => ACCOUNT_FIELD_RE.test(f.name) && BUNDLE_KIND[f.$type] && f.bundle && f.$type !== 'StateProjectCustomField');
}

/* ---------------------------------------------------------------- render */

function render() {
  const ic = { ok: '✓', todo: '+', warn: '!', err: '×' };
  $('rows').innerHTML = st.items.map((it) => `
    <li class="row ${it.status}" data-key="${it.key}">
      <span class="ic" aria-hidden="true">${ic[it.status]}</span>
      <div class="body">
        <div class="t">${esc(it.title)}</div>
        <div class="d">${esc(it.desc)}</div>
        ${it.optional && it.status === 'todo' ? `<label class="opt"><input type="checkbox" data-opt="${it.key}"${it.checked ? ' checked' : ''}> Add this field</label>` : ''}
      </div>
      <span class="tag">${esc(it.tag)}</span>
    </li>`).join('');

  $('productCard').hidden = false;
  const vals = st.account ? st.account.bundle.values.filter((v) => !v.archived).map((v) => v.name) : [];
  if (st.account) {
    $('productHint').textContent = `The account switcher uses "${st.account.name}"`
      + (vals.length ? ` (${vals.join(', ')}).` : ' (no values yet).') + ' Optionally add more names, separated by commas.';
    $('productLabel').textContent = `New values for ${st.account.name}`;
  } else {
    $('productHint').textContent = 'Optional. Enter product or brand names, separated by commas, to create a Product field. '
      + 'The grid then gets an account switcher, one feed per product.';
    $('productLabel').textContent = 'Product names';
  }
  updateButton();
}

function productNames() {
  const have = st.account ? st.account.bundle.values.map((v) => v.name.toLowerCase()) : [];
  const seen = new Set();
  return $('productNames').value.split(',').map((s) => s.trim()).filter(Boolean)
    .filter((n) => { const k = n.toLowerCase(); if (seen.has(k) || have.includes(k)) return false; seen.add(k); return true; });
}

function plan() {
  const steps = [];
  const sharedBundles = [];
  for (const it of st.items) {
    if (it.status !== 'todo' || (it.optional && !it.checked)) continue;
    if (it.key === 'publish') steps.push({ label: `Add the ${POST_DATE} field`, run: () => ensureDateField(POST_DATE) });
    if (it.key === 'adStart') steps.push({ label: `Add the ${AD_START} field`, run: () => ensureDateField(AD_START) });
    if (it.key === 'adEnd') steps.push({ label: `Add the ${AD_END} field`, run: () => ensureDateField(AD_END) });
    if (it.key === 'type') {
      if (it.global) {
        steps.push({ label: `Add the Type field with "${IG_VALUE}"`, run: () => attachTypeField(it.global) });
        sharedBundles.push(it.global.fieldDefaults.bundle.name || 'Type');
      } else if (it.value) {
        steps.push({ label: `Restore "${it.value.name}" in ${it.field.name}`, run: () => restoreValue(it.field, it.value) });
        sharedBundles.push(it.field.bundle.name);
      } else {
        steps.push({ label: `Add "${IG_VALUE}" to ${it.field.name}`, run: () => addValue(it.field, IG_VALUE) });
        sharedBundles.push(it.field.bundle.name);
      }
    }
  }
  const names = productNames();
  if (names.length) {
    if (st.account) {
      steps.push({ label: `Add ${names.join(', ')} to ${st.account.name}`, run: async () => { for (const n of names) await addValue(st.account, n); } });
      sharedBundles.push(st.account.bundle.name);
    } else {
      steps.push({ label: `Create a ${PRODUCT_FIELD} field with ${names.join(', ')}`, run: () => createProductField(names) });
    }
  }
  return { steps, sharedBundles: [...new Set(sharedBundles.filter(Boolean))] };
}

function updateButton() {
  const n = plan().steps.length;
  $('applyBtn').disabled = st.busy || n === 0;
  $('applyBtn').textContent = n ? `Set up (${n})` : 'Everything is set up';
}

/* ---------------------------------------------------------------- write */

async function ensureDateField(name) {
  if (projectField((f) => same(f.name, name))) return 'already in the project';
  let g = st.globals?.find((f) => same(f.name, name)) || null;
  if (g && !DATE_TYPES.includes(g.fieldType?.id)) {
    throw new Error(`a field named "${name}" already exists with the type "${g.fieldType?.id}"`);
  }
  let created = false;
  if (!g) {
    g = await post('admin/customFieldSettings/customFields?fields=id,name,fieldType(id)', {
      name, fieldType: { id: 'date' }, isAutoAttached: false, isDisplayedInIssueList: true,
    });
    created = true;
  }
  await post(`admin/projects/${st.project.id}/customFields?fields=id`, {
    $type: 'SimpleProjectCustomField', field: { id: g.id }, canBeEmpty: true, emptyFieldText: 'No date', isPublic: true,
  });
  return created ? 'created and added' : 'existing field added';
}

async function addValue(pf, name) {
  const kind = BUNDLE_KIND[pf.$type];
  const body = kind === 'state' ? { name, isResolved: false } : { name };
  await post(`admin/customFieldSettings/bundles/${kind}/${pf.bundle.id}/values?fields=id,name`, body);
  return 'added';
}

async function restoreValue(pf, v) {
  const kind = BUNDLE_KIND[pf.$type];
  await post(`admin/customFieldSettings/bundles/${kind}/${pf.bundle.id}/values/${v.id}?fields=id`, { archived: false });
  return 'restored';
}

async function attachTypeField(g) {
  const bundle = g.fieldDefaults.bundle;
  const pf = await post(`admin/projects/${st.project.id}/customFields?fields=id,$type,bundle(id,values(id,name,archived))`, {
    $type: 'EnumProjectCustomField', field: { id: g.id }, bundle: { id: bundle.id, $type: bundle.$type || 'EnumBundle' },
    canBeEmpty: true, isPublic: true,
  });
  const values = pf?.bundle?.values || [];
  const v = values.find((x) => IG_VALUE_RE.test(x.name));
  const target = { $type: 'EnumProjectCustomField', bundle: { id: bundle.id } };
  if (!v) await addValue(target, IG_VALUE);
  else if (v.archived) await restoreValue(target, v);
  return 'added';
}

async function createProductField(names) {
  const base = `${st.project.name} products`;
  let bundle;
  try {
    bundle = await post('admin/customFieldSettings/bundles/enum?fields=id,name', { name: base, values: names.map((name) => ({ name })) });
  } catch {
    // Bundle names must be unique; retry once with a suffix
    bundle = await post('admin/customFieldSettings/bundles/enum?fields=id,name', {
      name: `${base} (${st.project.shortName}-${Date.now() % 10000})`, values: names.map((name) => ({ name })),
    });
  }
  let fieldName = PRODUCT_FIELD;
  let g = st.globals?.find((f) => same(f.name, fieldName)) || null;
  if (g && !String(g.fieldType?.id).startsWith('enum')) { fieldName = `${PRODUCT_FIELD} (Instagram)`; g = st.globals?.find((f) => same(f.name, fieldName)) || null; }
  if (!g) {
    g = await post('admin/customFieldSettings/customFields?fields=id,name', {
      name: fieldName, fieldType: { id: 'enum[1]' }, isAutoAttached: false, isDisplayedInIssueList: true,
      fieldDefaults: { $type: 'EnumBundleCustomFieldDefaults', bundle: { id: bundle.id, $type: 'EnumBundle' } },
    });
  }
  await post(`admin/projects/${st.project.id}/customFields?fields=id`, {
    $type: 'EnumProjectCustomField', field: { id: g.id }, bundle: { id: bundle.id, $type: 'EnumBundle' },
    canBeEmpty: true, emptyFieldText: 'No product', isPublic: true,
  });
  return `${fieldName} created`;
}

/* ---------------------------------------------------------------- flow */

function openConfirm() {
  const { steps, sharedBundles } = plan();
  if (!steps.length) return;
  $('plan').innerHTML = steps.map((s) => `<li>${esc(s.label)}</li>`).join('');
  const note = $('sharedNote');
  note.hidden = !sharedBundles.length;
  note.textContent = sharedBundles.length
    ? `Values are added to the value set${sharedBundles.length > 1 ? 's' : ''} ${sharedBundles.map((b) => `"${b}"`).join(', ')}. `
      + 'Other projects that use the same set will see the new values too. Existing issues are not changed.'
    : '';
  $('confirm').hidden = false;
  $('confirmBtn').focus();
}

async function apply() {
  const { steps } = plan();
  $('confirm').hidden = true;
  st.busy = true; updateButton();
  $('logCard').hidden = false;
  $('log').innerHTML = '';
  let failed = 0;
  for (const s of steps) {
    const li = document.createElement('li');
    li.className = 'row todo';
    li.innerHTML = `<span class="ic" aria-hidden="true">…</span><div class="body"><div class="t">${esc(s.label)}</div><div class="d">Working…</div></div>`;
    $('log').appendChild(li);
    try {
      const res = await s.run();
      li.className = 'row ok'; li.querySelector('.ic').textContent = '✓'; li.querySelector('.d').textContent = res || 'Done';
    } catch (e) {
      failed++;
      console.error(e);
      li.className = 'row err'; li.querySelector('.ic').textContent = '×';
      li.querySelector('.d').textContent = 'Failed: ' + errText(e)
        + (/forbidden|permission|403/i.test(errText(e)) ? ' — this step needs an administrator who can manage custom fields.' : '');
    }
  }
  st.busy = false;
  $('productNames').value = '';
  await refresh();
  setStatus(failed ? `${failed} step${failed > 1 ? 's' : ''} failed. See the details below.` : 'Done. Reload the Post Grid Planner tab to see the changes.', failed > 0);
}

async function refresh() {
  setStatus('Checking…');
  try {
    await load();
    analyze();
    render();
    setStatus('');
  } catch (e) {
    console.error(e);
    $('rows').innerHTML = '';
    setStatus('Could not read the project fields: ' + errText(e), true);
  }
}

function bind() {
  $('rows').addEventListener('change', (e) => {
    const k = e.target.dataset?.opt;
    if (!k) return;
    const it = st.items.find((x) => x.key === k);
    if (it) it.checked = e.target.checked;
    updateButton();
  });
  $('productNames').addEventListener('input', updateButton);
  $('applyBtn').addEventListener('click', openConfirm);
  $('reloadBtn').addEventListener('click', refresh);
  $('cancelBtn').addEventListener('click', () => { $('confirm').hidden = true; });
  $('confirmBtn').addEventListener('click', apply);
  $('confirm').addEventListener('mousedown', (e) => { if (e.target === $('confirm')) $('confirm').hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('confirm').hidden = true; });
}

if (!host) {
  setStatus('Open this tab inside YouTrack.', true);
  $('rows').innerHTML = '';
} else {
  bind();
  refresh();
}

/* @preview-start — removed from the release build by build.py */
/* Sample REST backend for working on this page outside YouTrack. ?empty starts with a bare project. */
function createSetupMock() {
  const empty = /empty/.test(location.search);
  let n = 100;
  const id = (p) => `${p}-${++n}`;
  const bundles = {
    enum: [
      { id: '6-1', name: 'Types', $type: 'EnumBundle', values: [{ id: '7-1', name: 'Bug' }, { id: '7-2', name: 'Task' }, { id: '7-3', name: 'Feature' }] },
      { id: '6-2', name: 'Product | Department', $type: 'EnumBundle', values: [{ id: '7-4', name: 'YT MarketPlace' }, { id: '7-5', name: 'Codeo' }] },
    ],
  };
  const globals = [
    { id: '58-1', name: 'Type', fieldType: { id: 'enum[1]' }, fieldDefaults: { bundle: { id: '6-1', name: 'Types', $type: 'EnumBundle' } } },
    { id: '58-2', name: 'Due Date', fieldType: { id: 'date' } },
    { id: '58-3', name: 'Product | Department', fieldType: { id: 'enum[1]' }, fieldDefaults: { bundle: { id: '6-2', name: 'Product | Department', $type: 'EnumBundle' } } },
  ];
  const projectFields = empty ? [] : [
    { id: '105-1', $type: 'EnumProjectCustomField', field: globals[0], bundle: bundles.enum[0] },
    { id: '105-2', $type: 'SimpleProjectCustomField', field: globals[1] },
    { id: '105-3', $type: 'EnumProjectCustomField', field: globals[2], bundle: bundles.enum[1] },
  ];
  const findBundle = (bid) => bundles.enum.find((b) => b.id === bid);
  const clone = (v) => new Promise((r) => setTimeout(() => r(structuredClone(v)), 60));
  window.__setupCalls = [];
  return {
    async fetchYouTrack(url, params = {}) {
      const m = params.method || 'GET';
      const b = params.body;
      window.__setupCalls.push(`${m} ${url.split('?')[0]}`);
      if (m === 'GET' && /^admin\/projects\/[^/]+\?/.test(url)) return clone({ id: '0-1', name: 'Product Marketing', shortName: 'PM' });
      if (m === 'GET' && /^admin\/projects\/[^/]+\/customFields/.test(url)) return clone(projectFields);
      if (m === 'GET' && url.startsWith('admin/customFieldSettings/customFields')) return clone(globals);
      if (m === 'POST' && url.startsWith('admin/customFieldSettings/customFields')) {
        if (globals.some((g) => g.name === b.name)) throw new Error('Field name must be unique');
        const g = { id: id('58'), name: b.name, fieldType: b.fieldType, fieldDefaults: b.fieldDefaults };
        globals.push(g); return clone(g);
      }
      if (m === 'POST' && /^admin\/projects\/[^/]+\/customFields/.test(url)) {
        const g = globals.find((x) => x.id === b.field.id);
        const pf = { id: id('105'), $type: b.$type, field: g, bundle: b.bundle ? findBundle(b.bundle.id) : undefined };
        projectFields.push(pf); return clone(pf);
      }
      if (m === 'POST' && /^admin\/customFieldSettings\/bundles\/enum\?/.test(url)) {
        if (bundles.enum.some((x) => x.name === b.name)) throw new Error('Bundle name must be unique');
        const nb = { id: id('6'), name: b.name, $type: 'EnumBundle', values: b.values.map((v) => ({ id: id('7'), name: v.name })) };
        bundles.enum.push(nb); return clone(nb);
      }
      const vm = url.match(/^admin\/customFieldSettings\/bundles\/enum\/([^/]+)\/values(?:\/([^/?]+))?/);
      if (m === 'POST' && vm) {
        const bun = findBundle(vm[1]);
        if (vm[2]) { const v = bun.values.find((x) => x.id === vm[2]); Object.assign(v, b); return clone(v); }
        if (bun.values.some((x) => x.name === b.name)) throw new Error('Value already exists');
        const v = { id: id('7'), name: b.name }; bun.values.push(v); return clone(v);
      }
      throw new Error('mock: ' + m + ' ' + url);
    },
  };
}
/* @preview-end */
