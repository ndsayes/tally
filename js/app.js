import { db } from './db.js';
import {
  MEALS, MEAL_NAMES, mealForNow, round1, round2, unitsFor, unitLabel, scale, amountText, sumEntries,
} from './nutrition.js';
import { lookupBarcode, sameBarcode } from './off.js';
import { readLabel, parseMeal, testKey, MODELS, DEFAULT_MODEL } from './ai.js';
import { prepImage } from './images.js';
import { createScanner, cameraErrorText } from './scanner.js';

// ---------- helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const pad = (n) => String(n).padStart(2, '0');
const todayStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function shiftDate(str, days) {
  const [y, m, d] = str.split('-').map(Number);
  return todayStr(new Date(y, m - 1, d + days));
}

function dateLabel(str) {
  const t = todayStr();
  if (str === t) return 'Today';
  if (str === shiftDate(t, -1)) return 'Yesterday';
  if (str === shiftDate(t, 1)) return 'Tomorrow';
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

const ICONS = {
  barcode: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6v12M7 6v12M10 6v12M14 6v12M17 6v12M20 6v12"/></svg>',
  label: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H10l-5 4v-4H4z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
};

const numField = (name, label, value, attrs = '') =>
  `<label class="field"><span>${label}</span><input name="${name}" type="number" inputmode="decimal" step="any" min="0" value="${esc(value ?? '')}" ${attrs}></label>`;
const textField = (name, label, value, attrs = '') =>
  `<label class="field"><span>${label}</span><input name="${name}" type="text" value="${esc(value ?? '')}" ${attrs}></label>`;
const mealSelect = (meal) =>
  `<label class="field"><span>Meal</span><select name="meal">${MEALS.map(
    (m) => `<option value="${m}" ${m === meal ? 'selected' : ''}>${MEAL_NAMES[m]}</option>`,
  ).join('')}</select></label>`;
const val = (root, name) => $(`[name="${name}"]`, root).value.trim();
const numVal = (root, name) => {
  const v = parseFloat(val(root, name));
  return Number.isFinite(v) && v >= 0 ? v : 0;
};
const macroLine = (n) => `${fmt(n.kcal)} kcal · P ${fmt(n.protein)} g · C ${fmt(n.carbs)} g · F ${fmt(n.fat)} g`;

async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => (t.hidden = true), 250);
  }, 2200);
}

// ---------- state & storage ----------

const DEFAULT_GOALS = { kcal: 2000, protein: 150, carbs: 200, fat: 67 };
const state = { date: todayStr(), today: todayStr(), settings: null, entries: [], foods: [] };

async function loadSettings() {
  const saved = (await db.get('settings', 'main')) || {};
  state.settings = { goals: { ...DEFAULT_GOALS }, apiKey: '', model: DEFAULT_MODEL, goalsSet: false, ...saved };
}
const saveSettings = () => db.put('settings', state.settings, 'main');

async function loadDay() {
  state.entries = (await db.byIndex('entries', 'date', state.date)).sort((a, b) => a.createdAt - b.createdAt);
}
async function loadFoods() {
  state.foods = await db.all('foods');
}

async function saveFood(food) {
  if (!food.id) {
    food.id = uid();
    food.createdAt = Date.now();
  }
  await db.put('foods', food);
  const i = state.foods.findIndex((f) => f.id === food.id);
  if (i >= 0) state.foods[i] = food;
  else state.foods.push(food);
  return food;
}

async function touchFood(food, qty, unitKey) {
  Object.assign(food, { lastUsed: Date.now(), useCount: (food.useCount || 0) + 1, lastQty: qty, lastUnit: unitKey });
  await db.put('foods', food);
}

function foodEntry(food, qty, unitKey, meal) {
  return {
    meal,
    foodId: food.id,
    name: food.name,
    brand: food.brand || '',
    qty,
    unitKey,
    amount: amountText(food, qty, unitKey),
    estimate: food.source === 'ai',
    ...scale(food, qty, unitKey),
  };
}

async function addEntry(entry) {
  const e = { id: uid(), date: state.date, createdAt: Date.now(), ...entry };
  await db.put('entries', e);
  return e;
}

async function refreshToday() {
  await loadDay();
  renderToday();
}

async function afterLog(msg) {
  closeSheet();
  await refreshToday();
  toast(msg);
}

// ---------- Today screen ----------

function bar(v, goal, cls) {
  const p = goal > 0 ? Math.min(100, (v / goal) * 100) : 0;
  return `<div class="bar ${cls} ${goal > 0 && v > goal ? 'over' : ''}"><span style="width:${p}%"></span></div>`;
}

function macro(label, key, t, g) {
  return `<div class="macro"><div class="macro-head"><span>${label}</span><span class="muted">${fmt(t[key])} / ${fmt(g[key])} g</span></div>${bar(t[key], g[key], key)}</div>`;
}

function entryRow(e) {
  const detail = [e.amount, `P ${fmt(e.protein)} · C ${fmt(e.carbs)} · F ${fmt(e.fat)}`].filter(Boolean).join(' · ');
  return `<li><button class="entry" data-entry="${e.id}">
    <div class="entry-main"><div class="entry-name">${esc(e.name)}${e.estimate ? ' <span class="badge">estimate</span>' : ''}</div>
    <div class="muted small">${esc(detail)}</div></div>
    <div class="entry-kcal">${fmt(e.kcal)}</div></button></li>`;
}

function mealCard(m) {
  const items = state.entries.filter((e) => e.meal === m);
  const kcal = items.reduce((s, e) => s + (e.kcal || 0), 0);
  return `<section class="card meal">
    <div class="meal-head"><h3>${MEAL_NAMES[m]}</h3><span class="muted">${items.length ? `${fmt(kcal)} kcal` : ''}</span>
    <button class="add-btn" data-add="${m}">+ Add</button></div>
    ${items.length ? `<ul class="entries">${items.map(entryRow).join('')}</ul>` : ''}
  </section>`;
}

function renderToday() {
  $('#dateLabel').textContent = dateLabel(state.date);
  const g = state.settings.goals;
  const t = sumEntries(state.entries);
  const left = Math.round(g.kcal - t.kcal);
  const over = left < 0;
  $('#today').innerHTML = `
    ${state.settings.goalsSet ? '' : '<button class="banner" data-act="settings">Set your daily calorie and macro targets ›</button>'}
    <section class="card summary">
      <div class="kcal-row">
        <div><div class="big ${over ? 'over' : ''}">${fmt(Math.abs(left))}</div><div class="muted">${over ? 'kcal over' : 'kcal left'}</div></div>
        <div class="kcal-math muted"><div>${fmt(g.kcal)} goal</div><div>− ${fmt(t.kcal)} eaten</div></div>
      </div>
      ${bar(t.kcal, g.kcal, 'kcal')}
      <div class="macros">${macro('Protein', 'protein', t, g)}${macro('Carbs', 'carbs', t, g)}${macro('Fat', 'fat', t, g)}</div>
    </section>
    ${MEALS.map(mealCard).join('')}`;
}

$('#today').addEventListener('click', (ev) => {
  const add = ev.target.closest('[data-add]');
  if (add) return openSheet(addMenu(add.dataset.add));
  const entry = ev.target.closest('[data-entry]');
  if (entry) return openEntry(entry.dataset.entry);
  if (ev.target.closest('[data-act="settings"]')) openSheet(settingsScreen());
});

$('#prevDay').onclick = async () => {
  state.date = shiftDate(state.date, -1);
  await refreshToday();
};
$('#nextDay').onclick = async () => {
  state.date = shiftDate(state.date, 1);
  await refreshToday();
};
$('#dateLabel').onclick = async () => {
  state.date = todayStr();
  await refreshToday();
};
$('#openSettings').onclick = () => openSheet(settingsScreen());
$('#fab').onclick = () => openSheet(addMenu(mealForNow()));

function openEntry(id) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  const food = e.foodId && state.foods.find((f) => f.id === e.foodId);
  openSheet(food ? amountScreen(food, e.meal, e) : entryEditor(e));
}

// ---------- bottom sheet with a simple screen stack ----------
// A screen is { title, render(body), leave?() }.

const sheetEl = $('#sheet');
const sheetBody = $('#sheetBody');
const stack = [];
const isTop = (screen) => stack.at(-1) === screen;

function showScreen() {
  const s = stack.at(-1);
  $('#sheetTitle').textContent = s.title;
  $('#sheetBack').textContent = stack.length > 1 ? '‹ Back' : 'Close';
  // A fresh container per render, so each screen's event listeners go away with it.
  const body = document.createElement('div');
  sheetBody.replaceChildren(body);
  sheetBody.scrollTop = 0;
  s.render(body);
}

function openSheet(screen) {
  stack.splice(0).forEach((s) => s.leave?.());
  stack.push(screen);
  sheetEl.hidden = false;
  requestAnimationFrame(() => sheetEl.classList.add('open'));
  document.body.classList.add('sheet-open');
  showScreen();
}

function push(screen) {
  stack.at(-1)?.leave?.();
  stack.push(screen);
  showScreen();
}

function replace(screen) {
  stack.pop()?.leave?.();
  stack.push(screen);
  showScreen();
}

function back() {
  stack.pop()?.leave?.();
  if (stack.length) showScreen();
  else closeSheet();
}

function closeSheet() {
  stack.splice(0).forEach((s) => s.leave?.());
  sheetEl.classList.remove('open');
  document.body.classList.remove('sheet-open');
  setTimeout(() => {
    if (!stack.length) {
      sheetEl.hidden = true;
      sheetBody.innerHTML = '';
    }
  }, 250);
}

$('#sheetBack').onclick = back;
sheetEl.addEventListener('click', (ev) => {
  if (ev.target === sheetEl) closeSheet();
});

function requireKey() {
  if (state.settings.apiKey) return true;
  if (confirm('This needs your Claude API key. Open Settings to add it?')) push(settingsScreen());
  return false;
}

// ---------- Add menu ----------

function foodSubtitle(f) {
  return [f.brand, `${fmt(f.kcal)} kcal per ${unitLabel(f, 'per')}`].filter(Boolean).join(' · ');
}

function addMenu(meal) {
  const tile = (act, icon, label) => `<button class="tile" data-act="${act}">${icon}<span>${label}</span></button>`;
  let query = '';
  const self = {
    title: `Add to ${MEAL_NAMES[meal]}`,
    render(body) {
      body.innerHTML = `
        <div class="tiles">
          ${tile('scan', ICONS.barcode, 'Scan barcode')}
          ${tile('label', ICONS.label, 'Snap a label')}
          ${tile('describe', ICONS.chat, 'Describe it')}
          ${tile('photo', ICONS.camera, 'Photo of meal')}
        </div>
        <button class="row-link" data-act="quick"><span>Quick add calories</span><span>›</span></button>
        <h4 class="section-label">My foods</h4>
        <input type="search" class="search" placeholder="Search my foods" autocomplete="off" enterkeyhint="search" value="${esc(query)}">
        <div class="food-list"></div>`;

      const list = $('.food-list', body);
      const draw = () => {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const foods = state.foods
          .filter((f) => tokens.every((t) => `${f.name} ${f.brand || ''}`.toLowerCase().includes(t)))
          .sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0));
        list.innerHTML = foods.length
          ? foods
              .map(
                (f) => `<div class="food-row">
                  <button class="food-main" data-food="${f.id}"><div class="entry-name">${esc(f.name)}</div><div class="muted small">${esc(foodSubtitle(f))}</div></button>
                  <button class="quick-add" data-quick="${f.id}" aria-label="Log ${esc(f.name)} again">+</button></div>`,
              )
              .join('')
          : `<p class="muted small empty">${
              state.foods.length ? 'No matches.' : 'Foods you scan, snap or save will appear here, ready to log again in one tap.'
            }</p>`;
      };
      draw();

      $('.search', body).addEventListener('input', (e) => {
        query = e.target.value;
        draw();
      });

      body.addEventListener('click', async (ev) => {
        const act = ev.target.closest('[data-act]')?.dataset.act;
        if (act === 'scan') return push(scanScreen(meal));
        if (act === 'label') return push(labelScreen(meal));
        if (act === 'describe') return push(describeScreen(meal));
        if (act === 'photo') return push(photoScreen(meal));
        if (act === 'quick') return push(quickAddScreen(meal));
        const foodBtn = ev.target.closest('[data-food]');
        if (foodBtn) return push(amountScreen(state.foods.find((f) => f.id === foodBtn.dataset.food), meal));
        const quick = ev.target.closest('[data-quick]');
        if (quick) {
          // Log again with the amount used last time, and stay here to add more.
          const food = state.foods.find((f) => f.id === quick.dataset.quick);
          const unitKey = unitsFor(food).some((u) => u.key === food.lastUnit) ? food.lastUnit : 'per';
          const qty = food.lastQty || 1;
          await addEntry(foodEntry(food, qty, unitKey, meal));
          await touchFood(food, qty, unitKey);
          await refreshToday();
          toast(`Added ${food.name} (${amountText(food, qty, unitKey)})`);
          if (isTop(self)) draw();
        }
      });
    },
  };
  return self;
}

// ---------- Amount picker (log or edit an entry for a saved food) ----------

function amountScreen(food, meal, entry = null) {
  const units = unitsFor(food);
  let qty = entry?.qty ?? food.lastQty ?? 1;
  let unitKey = entry?.unitKey ?? food.lastUnit ?? 'per';
  if (!units.some((u) => u.key === unitKey)) unitKey = 'per';

  const self = {
    title: entry ? 'Edit entry' : 'How much?',
    render(body) {
      const hasPackage = units.some((u) => u.key === 'package');
      body.innerHTML = `
        <div class="food-head">
          <div class="title">${esc(food.name)}</div>
          ${food.brand ? `<div class="muted">${esc(food.brand)}</div>` : ''}
          <div class="muted small">Per ${esc(unitLabel(food, 'per'))}: ${esc(macroLine(food))}</div>
        </div>
        <div class="amount-row">
          <input class="qty" type="number" inputmode="decimal" step="any" min="0" value="${qty}" aria-label="Amount">
          <select class="unit" aria-label="Unit">${units
            .map((u) => `<option value="${u.key}" ${u.key === unitKey ? 'selected' : ''}>${esc(unitLabel(food, u.key))}</option>`)
            .join('')}</select>
        </div>
        ${
          hasPackage
            ? `<div class="chips">${[
                [0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [0.75, '¾'], [1, 'All'],
              ].map(([v, l]) => `<button class="chip" data-frac="${v}">${l} package</button>`).join('')}</div>`
            : ''
        }
        <div class="preview"></div>
        ${mealSelect(meal)}
        <button class="btn primary save">${entry ? 'Save' : 'Add'}</button>
        ${entry ? '<button class="btn danger-outline del">Delete entry</button>' : ''}
        <button class="link edit-food">Edit food details</button>`;

      const qtyEl = $('.qty', body);
      const unitEl = $('.unit', body);
      const preview = () => {
        qty = parseFloat(qtyEl.value) || 0;
        unitKey = unitEl.value;
        $('.preview', body).textContent = macroLine(scale(food, qty, unitKey));
      };
      preview();
      qtyEl.addEventListener('input', preview);
      unitEl.addEventListener('change', preview);
      $$('.chip', body).forEach((c) =>
        c.addEventListener('click', () => {
          qtyEl.value = round2(parseFloat(c.dataset.frac));
          unitEl.value = 'package';
          preview();
        }),
      );

      $('.save', body).onclick = async () => {
        if (!(qty > 0)) return toast('Enter an amount');
        const data = foodEntry(food, qty, unitKey, val(body, 'meal'));
        if (entry) await db.put('entries', { ...entry, ...data });
        else await addEntry(data);
        await touchFood(food, qty, unitKey);
        afterLog(entry ? 'Saved' : `Added ${food.name}`);
      };
      $('.del', body)?.addEventListener('click', async () => {
        if (!confirm('Delete this entry?')) return;
        await db.delete('entries', entry.id);
        afterLog('Deleted');
      });
      $('.edit-food', body).onclick = () =>
        push(
          foodEditor(food, {
            onSaved: () => back(),
            onDeleted: () => (entry ? closeSheet() : (back(), back())),
          }),
        );
    },
  };
  return self;
}

// ---------- Food editor ----------

function foodEditor(food, { title = 'Food details', note = '', onSaved, onDeleted } = {}) {
  return {
    title,
    render(body) {
      body.innerHTML = `
        ${note ? `<p class="note">${esc(note)}</p>` : ''}
        <form class="form" novalidate>
          ${textField('name', 'Name', food.name, 'required autocomplete="off"')}
          ${textField('brand', 'Brand (optional)', food.brand, 'autocomplete="off"')}
          <div class="group-label">Nutrition for</div>
          <div class="two">
            ${textField('perLabel', 'Amount', food.per?.label ?? '1 serving', 'autocomplete="off"')}
            ${numField('perGrams', 'Its weight in g', food.per?.grams ?? '')}
          </div>
          <div class="two">${numField('kcal', 'Calories', food.kcal ?? '')}${numField('protein', 'Protein (g)', food.protein ?? '')}</div>
          <div class="two">${numField('carbs', 'Carbs (g)', food.carbs ?? '')}${numField('fat', 'Fat (g)', food.fat ?? '')}</div>
          ${numField('packageGrams', 'Whole package weight in g (optional)', food.packageGrams ?? '')}
          ${textField('barcode', 'Barcode (optional)', food.barcode ?? '', 'inputmode="numeric" autocomplete="off"')}
          <p class="muted small">Add the weight to log in grams, and the package weight to log "half the package".</p>
          <button class="btn primary" type="submit">Save food</button>
        </form>
        ${food.id && onDeleted ? '<button class="btn danger-outline del">Delete this food</button>' : ''}`;

      $('form', body).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = val(body, 'name');
        if (!name) return toast('Give it a name');
        if (val(body, 'kcal') === '') return toast('Enter the calories');
        const perGrams = numVal(body, 'perGrams');
        const packageGrams = numVal(body, 'packageGrams');
        const barcode = val(body, 'barcode').replace(/\D/g, '');
        Object.assign(food, {
          name,
          brand: val(body, 'brand'),
          per: { label: val(body, 'perLabel') || (perGrams ? `${perGrams} g` : '1 serving'), grams: perGrams || null },
          kcal: Math.round(numVal(body, 'kcal')),
          protein: round1(numVal(body, 'protein')),
          carbs: round1(numVal(body, 'carbs')),
          fat: round1(numVal(body, 'fat')),
          packageGrams: packageGrams || null,
          source: food.source || 'manual',
        });
        if (barcode) food.barcode = barcode;
        else delete food.barcode;
        await saveFood(food);
        toast('Food saved');
        onSaved?.(food);
      });

      $('.del', body)?.addEventListener('click', async () => {
        if (!confirm(`Delete "${food.name}" from My Foods? Diary entries already logged are kept.`)) return;
        await db.delete('foods', food.id);
        state.foods = state.foods.filter((f) => f.id !== food.id);
        toast('Food deleted');
        onDeleted?.();
      });
    },
  };
}

// ---------- Barcode scanning ----------

function scanScreen(meal) {
  let scanner = null;
  const self = {
    title: 'Scan barcode',
    render(body) {
      body.innerHTML = `
        <div class="viewfinder"><video playsinline muted></video><div class="reticle"></div></div>
        <p class="status muted">Point the camera at the barcode and hold steady.</p>
        <form class="manual">
          <input name="code" inputmode="numeric" pattern="[0-9]*" placeholder="Or type the barcode number" autocomplete="off">
          <button class="btn secondary" type="submit">Look up</button>
        </form>
        <div class="fallback"></div>`;
      const status = $('.status', body);

      const found = async (code) => {
        scanner?.stop();
        if (!isTop(self)) return;
        status.textContent = `Read ${code}. Looking it up…`;
        await handleBarcode(code, meal, self, body);
      };

      scanner = createScanner($('video', body), found, (err) => {
        if (isTop(self)) status.textContent = cameraErrorText(err);
      });
      scanner.ready.catch((err) => {
        if (isTop(self)) status.textContent = cameraErrorText(err);
      });

      $('.manual', body).addEventListener('submit', (ev) => {
        ev.preventDefault();
        const code = val(body, 'code').replace(/\D/g, '');
        if (code.length >= 6) found(code);
      });
    },
    leave() {
      scanner?.stop();
    },
  };
  return self;
}

async function handleBarcode(code, meal, screen, body) {
  const local = state.foods.find((f) => sameBarcode(f.barcode, code));
  if (local) return replace(amountScreen(local, meal));

  let result;
  try {
    result = await lookupBarcode(code);
  } catch (err) {
    if (!isTop(screen)) return;
    $('.status', body).textContent = `Couldn't reach Open Food Facts (${err.message}).`;
    $('.fallback', body).innerHTML = '<button class="btn primary snap">Snap the label instead</button>';
    $('.snap', body).onclick = () => replace(labelScreen(meal, { barcode: code }));
    return;
  }
  if (!isTop(screen)) return;
  if (result?.complete) {
    const food = await saveFood({ ...result.food });
    return replace(amountScreen(food, meal));
  }
  replace(notFoundScreen(code, meal, result?.food));
}

function notFoundScreen(code, meal, partial) {
  return {
    title: 'Not in the database',
    render(body) {
      body.innerHTML = `
        <p>${
          partial
            ? `Open Food Facts knows <b>${esc(partial.name)}</b> but has no nutrition info for it.`
            : `Open Food Facts doesn't have barcode <b>${esc(code)}</b> yet.`
        }</p>
        <p class="muted">Snap the nutrition label once and it's saved to this barcode, so next time the scan is instant.</p>
        <button class="btn primary snap">Snap the label</button>
        <button class="btn secondary manual">Type it in myself</button>`;
      $('.snap', body).onclick = () => replace(labelScreen(meal, { barcode: code, hint: partial?.name || '' }));
      $('.manual', body).onclick = () =>
        replace(
          foodEditor(
            { name: partial?.name || '', brand: partial?.brand || '', barcode: code, per: { label: '1 serving', grams: null }, source: 'manual' },
            { title: 'New food', onSaved: (f) => replace(amountScreen(f, meal)) },
          ),
        );
    },
  };
}

// ---------- Photo helpers ----------

function photoPicker(body, photos, max, onChange) {
  const thumbs = $('.thumbs', body);
  const input = $('input[type="file"]', body);
  const draw = () => {
    thumbs.innerHTML = photos
      .map((p, i) => `<div class="thumb"><img src="${p.dataUrl}" alt=""><button data-rm="${i}" aria-label="Remove photo">×</button></div>`)
      .join('');
    $('.file-btn', body).hidden = photos.length >= max;
    onChange();
  };
  thumbs.addEventListener('click', (ev) => {
    const rm = ev.target.closest('[data-rm]');
    if (rm) {
      photos.splice(Number(rm.dataset.rm), 1);
      draw();
    }
  });
  input.addEventListener('change', async () => {
    for (const file of [...input.files].slice(0, max - photos.length)) {
      try {
        photos.push(await prepImage(file));
      } catch (err) {
        toast(err.message);
      }
    }
    input.value = '';
    draw();
  });
  draw();
}

const showError = (body, err) => {
  const s = $('.status', body);
  s.classList.add('error');
  s.textContent = err.message || String(err);
};

// ---------- Snap a label ----------

function labelScreen(meal, { barcode = '', hint = '' } = {}) {
  const photos = [];
  const self = {
    title: 'Snap a label',
    render(body) {
      body.innerHTML = `
        <p>Take a clear photo of the <b>Nutrition Facts</b> table. Add a photo of the front too if you like, so the name comes out right.</p>
        <div class="thumbs"></div>
        <label class="btn secondary file-btn">${ICONS.camera}<span>Add photo</span><input type="file" accept="image/*" hidden></label>
        ${textField('hint', 'What is it? (optional)', hint, 'placeholder="e.g. Costco bulgogi with jasmine rice" autocomplete="off"')}
        <button class="btn primary go">Read label</button>
        <p class="status small"></p>`;
      const go = $('.go', body);
      $('[name="hint"]', body).addEventListener('input', (e) => (hint = e.target.value));
      photoPicker(body, photos, 3, () => (go.disabled = photos.length === 0));

      go.onclick = async () => {
        if (!requireKey()) return;
        try {
          const r = await busy(go, 'Reading the label…', () =>
            readLabel({ apiKey: state.settings.apiKey, model: state.settings.model, images: photos, hint: hint.trim() }),
          );
          if (!isTop(self)) return;
          const draft = {
            name: r.name || hint || 'New food',
            brand: r.brand || '',
            barcode: barcode || undefined,
            per: { label: r.serving_label || (r.serving_grams ? `${r.serving_grams} g` : '1 serving'), grams: r.serving_grams > 0 ? r.serving_grams : null },
            kcal: Math.round(r.kcal),
            protein: round1(r.protein),
            carbs: round1(r.carbs),
            fat: round1(r.fat),
            packageGrams: r.package_grams > 0 ? r.package_grams : null,
            source: 'label',
          };
          replace(
            foodEditor(draft, {
              title: 'Check the label',
              note: `Check these against the label, then save.${r.notes ? ` Note: ${r.notes}` : ''}`,
              onSaved: (f) => replace(amountScreen(f, meal)),
            }),
          );
        } catch (err) {
          if (isTop(self)) showError(body, err);
        }
      };
    },
  };
  return self;
}

// ---------- Describe it / Photo of meal ----------

function describeScreen(meal) {
  let text = '';
  const self = {
    title: 'Describe it',
    render(body) {
      body.innerHTML = `
        <textarea class="big-input" rows="4" placeholder="e.g. 200 g Costco bulgogi with jasmine rice, and a can of Coke Zero">${esc(text)}</textarea>
        <p class="muted small">Tip: tap the microphone on your keyboard to say it. Amounts help: "200 g", "half the tray", "2 slices".</p>
        <button class="btn primary go">Work it out</button>
        <p class="status small"></p>`;
      const ta = $('textarea', body);
      ta.addEventListener('input', () => (text = ta.value));
      const go = $('.go', body);
      go.onclick = async () => {
        if (!text.trim()) return ta.focus();
        if (!requireKey()) return;
        try {
          const result = await busy(go, 'Working it out…', () =>
            parseMeal({ apiKey: state.settings.apiKey, model: state.settings.model, text: text.trim(), foods: state.foods }),
          );
          if (isTop(self)) push(reviewScreen(result, meal));
        } catch (err) {
          if (isTop(self)) showError(body, err);
        }
      };
    },
  };
  return self;
}

function photoScreen(meal) {
  const photos = [];
  let note = '';
  const self = {
    title: 'Photo of meal',
    render(body) {
      body.innerHTML = `
        <p>Take a photo of your plate from above. Claude will list what it sees with estimated portions. Photo estimates can be off by a third, so check them.</p>
        <div class="thumbs"></div>
        <label class="btn secondary file-btn">${ICONS.camera}<span>Take or choose photo</span><input type="file" accept="image/*" hidden></label>
        <textarea class="big-input" rows="2" placeholder="Optional note, e.g. about 250 g of rice, cooked in butter">${esc(note)}</textarea>
        <button class="btn primary go">Estimate</button>
        <p class="status small"></p>`;
      const go = $('.go', body);
      const ta = $('textarea', body);
      ta.addEventListener('input', () => (note = ta.value));
      photoPicker(body, photos, 1, () => (go.disabled = photos.length === 0));
      go.onclick = async () => {
        if (!requireKey()) return;
        try {
          const result = await busy(go, 'Looking at your meal…', () =>
            parseMeal({
              apiKey: state.settings.apiKey,
              model: state.settings.model,
              text: note.trim(),
              image: photos[0],
              foods: state.foods,
            }),
          );
          if (isTop(self)) push(reviewScreen(result, meal));
        } catch (err) {
          if (isTop(self)) showError(body, err);
        }
      };
    },
  };
  return self;
}

// ---------- Review AI results ----------

function toRow(it) {
  const food = it.matched_food_id ? state.foods.find((f) => f.id === it.matched_food_id) : null;
  if (food) {
    const keys = unitsFor(food).map((u) => u.key);
    let unitKey = keys.includes(it.unit) ? it.unit : null;
    let qty = it.quantity;
    if (!unitKey) {
      if (food.per.grams && it.grams > 0) {
        unitKey = 'g';
        qty = it.grams;
      } else unitKey = 'per';
    }
    if (!(qty > 0)) qty = 1;
    return { kind: 'food', food, qty: round2(qty), unitKey };
  }
  return {
    kind: 'est',
    name: it.name,
    grams: Math.round(it.grams || 0),
    kcal: Math.round(it.kcal || 0),
    protein: round1(it.protein),
    carbs: round1(it.carbs),
    fat: round1(it.fat),
    confidence: it.confidence,
    save: false,
  };
}

const rowNutrition = (r) => (r.kind === 'food' ? scale(r.food, r.qty, r.unitKey) : r);

function reviewScreen(result, meal) {
  const rows = (result.items || []).map(toRow);
  return {
    title: 'Check & add',
    render(body) {
      if (!rows.length) {
        body.innerHTML = `<p>Claude couldn't find any food in that. Go back and try describing it differently.</p>`;
        return;
      }
      const rowHtml = (r, i) => {
        if (r.kind === 'food') {
          return `<div class="review-item" data-i="${i}">
            <div class="ri-head"><strong>${esc(r.food.name)}</strong><span class="badge ok">My food</span><button class="rm" data-rm="${i}" aria-label="Remove">×</button></div>
            <div class="amount-row">
              <input class="qty" type="number" inputmode="decimal" step="any" min="0" value="${r.qty}" aria-label="Amount">
              <select class="unit" aria-label="Unit">${unitsFor(r.food)
                .map((u) => `<option value="${u.key}" ${u.key === r.unitKey ? 'selected' : ''}>${esc(unitLabel(r.food, u.key))}</option>`)
                .join('')}</select>
            </div>
            <div class="muted small numbers"></div></div>`;
        }
        return `<div class="review-item" data-i="${i}">
          <div class="ri-head"><input class="name" value="${esc(r.name)}" aria-label="Name"><span class="badge">${
            r.confidence === 'low' ? 'Rough guess' : r.confidence === 'high' ? 'Known values' : 'Estimate'
          }</span><button class="rm" data-rm="${i}" aria-label="Remove">×</button></div>
          ${r.grams ? `<div class="muted small">About ${fmt(r.grams)} g</div>` : ''}
          <div class="four">
            ${['kcal', 'protein', 'carbs', 'fat']
              .map(
                (k) =>
                  `<label class="field mini"><span>${{ kcal: 'kcal', protein: 'Protein', carbs: 'Carbs', fat: 'Fat' }[k]}</span><input data-k="${k}" type="number" inputmode="decimal" step="any" min="0" value="${r[k]}"></label>`,
              )
              .join('')}
          </div>
          <label class="check"><input type="checkbox" class="save" ${r.save ? 'checked' : ''}> Save to My Foods</label></div>`;
      };

      body.innerHTML = `
        ${result.note ? `<p class="note">${esc(result.note)}</p>` : ''}
        <div class="review-list">${rows.map(rowHtml).join('')}</div>
        <div class="total"></div>
        ${mealSelect(meal)}
        <button class="btn primary add">Add to diary</button>`;

      const update = () => {
        $$('.review-item', body).forEach((el) => {
          const r = rows[el.dataset.i];
          if (r.kind === 'food') $('.numbers', el).textContent = macroLine(rowNutrition(r));
        });
        const total = rows.reduce(
          (t, r) => {
            const n = rowNutrition(r);
            return { kcal: t.kcal + n.kcal, protein: t.protein + n.protein, carbs: t.carbs + n.carbs, fat: t.fat + n.fat };
          },
          { kcal: 0, protein: 0, carbs: 0, fat: 0 },
        );
        $('.total', body).textContent = `Total: ${macroLine(total)}`;
        $('.add', body).textContent = `Add ${rows.length} item${rows.length === 1 ? '' : 's'}`;
      };
      update();

      body.addEventListener('input', (ev) => {
        const el = ev.target.closest('.review-item');
        if (!el) return;
        const r = rows[el.dataset.i];
        if (ev.target.classList.contains('qty')) r.qty = parseFloat(ev.target.value) || 0;
        else if (ev.target.classList.contains('name')) r.name = ev.target.value;
        else if (ev.target.dataset.k) r[ev.target.dataset.k] = parseFloat(ev.target.value) || 0;
        else if (ev.target.classList.contains('save')) r.save = ev.target.checked;
        update();
      });
      body.addEventListener('change', (ev) => {
        const el = ev.target.closest('.review-item');
        if (!el) return;
        const r = rows[el.dataset.i];
        if (ev.target.classList.contains('unit')) r.unitKey = ev.target.value;
        if (ev.target.classList.contains('save')) r.save = ev.target.checked;
        update();
      });
      body.addEventListener('click', (ev) => {
        const rm = ev.target.closest('[data-rm]');
        if (!rm) return;
        rows.splice(Number(rm.dataset.rm), 1);
        showScreen();
      });

      $('.add', body).onclick = async () => {
        const mealSel = val(body, 'meal');
        for (const r of rows) {
          if (r.kind === 'food') {
            if (!(r.qty > 0)) continue;
            await addEntry(foodEntry(r.food, r.qty, r.unitKey, mealSel));
            await touchFood(r.food, r.qty, r.unitKey);
          } else if (r.save) {
            const food = await saveFood({
              name: r.name || 'Food',
              brand: '',
              per: { label: '1 portion', grams: r.grams || null },
              kcal: Math.round(r.kcal),
              protein: round1(r.protein),
              carbs: round1(r.carbs),
              fat: round1(r.fat),
              packageGrams: null,
              source: 'ai',
            });
            await addEntry({ ...foodEntry(food, 1, 'per', mealSel), estimate: r.confidence !== 'high' });
            await touchFood(food, 1, 'per');
          } else {
            await addEntry({
              meal: mealSel,
              name: r.name || 'Food',
              amount: r.grams ? `≈ ${fmt(r.grams)} g` : '',
              kcal: Math.round(r.kcal),
              protein: round1(r.protein),
              carbs: round1(r.carbs),
              fat: round1(r.fat),
              estimate: r.confidence !== 'high',
            });
          }
        }
        afterLog(`Added ${rows.length} item${rows.length === 1 ? '' : 's'}`);
      };
    },
  };
}

// ---------- Quick add & plain entry editing ----------

function nutritionFields(e = {}) {
  return `<div class="two">${numField('kcal', 'Calories', e.kcal ?? '')}${numField('protein', 'Protein (g)', e.protein ?? '')}</div>
    <div class="two">${numField('carbs', 'Carbs (g)', e.carbs ?? '')}${numField('fat', 'Fat (g)', e.fat ?? '')}</div>`;
}

const readNutrition = (body) => ({
  kcal: Math.round(numVal(body, 'kcal')),
  protein: round1(numVal(body, 'protein')),
  carbs: round1(numVal(body, 'carbs')),
  fat: round1(numVal(body, 'fat')),
});

function quickAddScreen(meal) {
  return {
    title: 'Quick add',
    render(body) {
      body.innerHTML = `
        ${textField('name', 'Name (optional)', '', 'placeholder="Quick add" autocomplete="off"')}
        ${nutritionFields()}
        ${mealSelect(meal)}
        <button class="btn primary save">Add</button>`;
      $('[name="kcal"]', body).focus();
      $('.save', body).onclick = async () => {
        if (val(body, 'kcal') === '') return toast('Enter the calories');
        await addEntry({ meal: val(body, 'meal'), name: val(body, 'name') || 'Quick add', amount: '', ...readNutrition(body) });
        afterLog('Added');
      };
    },
  };
}

function entryEditor(entry) {
  return {
    title: 'Edit entry',
    render(body) {
      body.innerHTML = `
        ${textField('name', 'Name', entry.name, 'autocomplete="off"')}
        ${textField('amount', 'Amount (note)', entry.amount, 'autocomplete="off"')}
        ${nutritionFields(entry)}
        ${mealSelect(entry.meal)}
        <button class="btn primary save">Save</button>
        <button class="btn danger-outline del">Delete entry</button>`;
      $('.save', body).onclick = async () => {
        await db.put('entries', {
          ...entry,
          name: val(body, 'name') || entry.name,
          amount: val(body, 'amount'),
          meal: val(body, 'meal'),
          ...readNutrition(body),
        });
        afterLog('Saved');
      };
      $('.del', body).onclick = async () => {
        if (!confirm('Delete this entry?')) return;
        await db.delete('entries', entry.id);
        afterLog('Deleted');
      };
    },
  };
}

// ---------- Settings ----------

function settingsScreen() {
  return {
    title: 'Settings',
    render(body) {
      const s = state.settings;
      const g = s.goals;
      body.innerHTML = `
        <h4 class="section-label">Daily targets</h4>
        <div class="two">${numField('kcal', 'Calories', g.kcal)}${numField('protein', 'Protein (g)', g.protein)}</div>
        <div class="two">${numField('carbs', 'Carbs (g)', g.carbs)}${numField('fat', 'Fat (g)', g.fat)}</div>
        <p class="muted small macro-check"></p>
        <button class="btn secondary split">Set macros from calories (30% protein · 40% carbs · 30% fat)</button>

        <h4 class="section-label">AI logging (Claude)</h4>
        <label class="field"><span>API key</span><input name="apiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="${esc(s.apiKey)}"></label>
        <p class="muted small">Stored only on this phone and sent only to Anthropic. Create one at console.anthropic.com → API keys.</p>
        <label class="field"><span>Model</span><select name="model">${MODELS.map(
          (m) => `<option value="${m.id}" ${m.id === s.model ? 'selected' : ''}>${esc(m.label)}</option>`,
        ).join('')}</select></label>
        <button class="btn secondary test">Test key</button>
        <p class="status small"></p>

        <button class="btn primary save">Save settings</button>

        <h4 class="section-label">Backup</h4>
        <p class="muted small">Your diary lives only on this phone. Export a backup now and then (the API key is not included).</p>
        <div class="two"><button class="btn secondary export">Export backup</button>
        <label class="btn secondary file-btn"><span>Import backup</span><input type="file" accept="application/json,.json" hidden></label></div>

        <h4 class="section-label">About</h4>
        <p class="muted small">Barcode data from <a href="https://world.openfoodfacts.org" target="_blank" rel="noopener">Open Food Facts</a>, available under the Open Database License. AI features use Claude by Anthropic.</p>
        <button class="btn danger-outline wipe">Delete all foods and diary entries</button>`;

      const check = () => {
        const kcal = numVal(body, 'protein') * 4 + numVal(body, 'carbs') * 4 + numVal(body, 'fat') * 9;
        const goal = numVal(body, 'kcal');
        const off = goal && Math.abs(kcal - goal) / goal > 0.05;
        $('.macro-check', body).textContent = `Your macros add up to ${fmt(kcal)} kcal${off ? ` (goal is ${fmt(goal)})` : ''}.`;
      };
      check();
      body.addEventListener('input', check);

      $('.split', body).onclick = () => {
        const kcal = numVal(body, 'kcal');
        $('[name="protein"]', body).value = Math.round((kcal * 0.3) / 4);
        $('[name="carbs"]', body).value = Math.round((kcal * 0.4) / 4);
        $('[name="fat"]', body).value = Math.round((kcal * 0.3) / 9);
        check();
      };

      $('.test', body).onclick = async (ev) => {
        const status = $('.status', body);
        status.classList.remove('error');
        const apiKey = val(body, 'apiKey');
        if (!apiKey) return (status.textContent = 'Paste your API key first.');
        try {
          await busy(ev.currentTarget, 'Testing…', () => testKey({ apiKey, model: val(body, 'model') }));
          status.textContent = 'It works.';
        } catch (err) {
          showError(body, err);
        }
      };

      $('.save', body).onclick = async () => {
        if (!(numVal(body, 'kcal') > 0)) return toast('Enter a calorie target');
        s.goals = {
          kcal: Math.round(numVal(body, 'kcal')),
          protein: Math.round(numVal(body, 'protein')),
          carbs: Math.round(numVal(body, 'carbs')),
          fat: Math.round(numVal(body, 'fat')),
        };
        s.apiKey = val(body, 'apiKey');
        s.model = val(body, 'model');
        s.goalsSet = true;
        await saveSettings();
        renderToday();
        toast('Settings saved');
        back();
      };

      $('.export', body).onclick = exportBackup;
      $('.file-btn input', body).addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (file) importBackup(file);
      });

      $('.wipe', body).onclick = async () => {
        if (!confirm('Delete ALL foods and diary entries from this phone? This cannot be undone. (Settings are kept.)')) return;
        await db.clear('entries');
        await db.clear('foods');
        state.foods = [];
        await refreshToday();
        toast('All data deleted');
      };
    },
  };
}

async function exportBackup() {
  const data = {
    app: 'tally',
    version: 1,
    exportedAt: new Date().toISOString(),
    goals: state.settings.goals,
    model: state.settings.model,
    foods: await db.all('foods'),
    entries: await db.all('entries'),
  };
  const name = `tally-backup-${todayStr()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("That file isn't a backup.");
  }
  if (data.app !== 'tally' || !Array.isArray(data.foods) || !Array.isArray(data.entries)) return toast("That file isn't a Tally backup.");
  if (!confirm(`Import ${data.foods.length} foods and ${data.entries.length} diary entries? Matching items will be updated; nothing else is deleted.`)) return;
  await db.putMany('foods', data.foods);
  await db.putMany('entries', data.entries);
  if (data.goals) {
    state.settings.goals = { ...state.settings.goals, ...data.goals };
    state.settings.goalsSet = true;
    await saveSettings();
  }
  await loadFoods();
  closeSheet();
  await refreshToday();
  toast('Backup imported');
}

// ---------- start ----------

async function init() {
  await loadSettings();
  await loadFoods();
  await refreshToday();
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

  // Reopening the app on a new day jumps to the new day.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const t = todayStr();
    if (t === state.today) return;
    if (state.date === state.today) state.date = t;
    state.today = t;
    await refreshToday();
  });
}

init();
