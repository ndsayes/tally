import { db } from './db.js';
import {
  MEALS, MEAL_NAMES, mealForNow, round1, round2, unitsFor, unitLabel, scale, amountText, sumEntries,
} from './nutrition.js';
import { lookupBarcode, sameBarcode } from './off.js';
import { readLabel, parseMeal, testKey, MODELS, DEFAULT_MODEL } from './ai.js';
import { prepImage } from './images.js';
import { createScanner, cameraErrorText } from './scanner.js';
import * as cloud from './cloud.js';

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
    estimate: food.source === 'ai' || !!food.estimated,
    ...scale(food, qty, unitKey),
  };
}

// Weight in grams of an amount of a food, or null when the food's weight is unknown.
function gramsOf(food, qty, unitKey) {
  const unit = unitsFor(food).find((u) => u.key === unitKey);
  return unit?.grams ? qty * unit.grams : null;
}

// A favorite meal is saved as one food made of several parts, e.g. yogurt + granola + honey.
// parts: [{ name, amount, grams|null, kcal, protein, carbs, fat, estimate }]
async function saveFavoriteMeal(name, parts) {
  const sum = (k) => parts.reduce((s, p) => s + (p[k] || 0), 0);
  const grams = parts.every((p) => p.grams > 0) ? Math.round(sum('grams')) : null;
  return saveFood({
    name,
    brand: '',
    per: { label: '1 serving', grams },
    kcal: Math.round(sum('kcal')),
    protein: round1(sum('protein')),
    carbs: round1(sum('carbs')),
    fat: round1(sum('fat')),
    packageGrams: null,
    source: 'meal',
    favorite: true,
    estimated: parts.some((p) => p.estimate),
    ingredients: parts.map(({ name: n, amount, kcal }) => ({ name: n, amount: amount || '', kcal: Math.round(kcal || 0) })),
  });
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
    ${items.length > 1 ? `<button class="link small fav-meal" data-fav="${m}">☆ Save this ${MEAL_NAMES[m].toLowerCase()} as a favorite</button>` : ''}
  </section>`;
}

async function saveMealAsFavorite(meal) {
  const items = state.entries.filter((e) => e.meal === meal);
  const name = prompt('Name this favorite (e.g. "Usual breakfast bowl")')?.trim();
  if (!name) return;
  const parts = items.map((e) => {
    const food = e.foodId && state.foods.find((f) => f.id === e.foodId);
    return { ...e, grams: food && e.unitKey ? gramsOf(food, e.qty, e.unitKey) : null };
  });
  await saveFavoriteMeal(name, parts);
  toast(`Saved "${name}" to favorites`);
}

function renderToday() {
  $('#dateLabel').textContent = dateLabel(state.date);
  const g = state.settings.goals;
  const t = sumEntries(state.entries);
  const left = Math.round(g.kcal - t.kcal);
  const over = left < 0;
  let banner = '';
  if (!state.settings.goalsSet) banner = 'Set your daily calorie and macro targets ›';
  else if (cloud.connected() && cloud.status.error) banner = `Backup to GitHub isn't working: ${cloud.status.error} ›`;
  else if (!cloud.connected()) banner = 'Turn on automatic backup so your diary is saved off this phone ›';
  $('#today').innerHTML = `
    ${banner ? `<button class="banner ${cloud.status.error ? 'warn' : ''}" data-act="settings">${esc(banner)}</button>` : ''}
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
  const fav = ev.target.closest('[data-fav]');
  if (fav) return saveMealAsFavorite(fav.dataset.fav);
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
        <input type="search" class="search" placeholder="Search my foods" autocomplete="off" enterkeyhint="search" value="${esc(query)}">
        <div class="lists"></div>`;

      const lists = $('.lists', body);
      const rows = (foods) =>
        `<div class="food-list">${foods
          .map(
            (f) => `<div class="food-row">
              <button class="food-main" data-food="${f.id}"><div class="entry-name">${f.favorite ? '<span class="star">★</span> ' : ''}${esc(f.name)}</div><div class="muted small">${esc(foodSubtitle(f))}</div></button>
              <button class="quick-add" data-quick="${f.id}" aria-label="Log ${esc(f.name)} again">+</button></div>`,
          )
          .join('')}</div>`;
      const draw = () => {
        const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
        const recent = (a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0);
        if (tokens.length) {
          const found = state.foods
            .filter((f) => tokens.every((t) => `${f.name} ${f.brand || ''}`.toLowerCase().includes(t)))
            .sort(recent);
          lists.innerHTML = found.length ? rows(found) : '<p class="muted small empty">No matches.</p>';
          return;
        }
        const favorites = state.foods.filter((f) => f.favorite).sort(recent);
        const others = state.foods.filter((f) => !f.favorite).sort(recent);
        lists.innerHTML = `
          <h4 class="section-label">Favorites</h4>
          ${
            favorites.length
              ? rows(favorites)
              : '<p class="muted small empty card-ish">Meals you have often, like a breakfast bowl or a shake, can be saved here and logged with one tap. Tick "Save as a favorite" after describing one, or tap ☆ on any food.</p>'
          }
          <h4 class="section-label">My foods</h4>
          ${
            others.length
              ? rows(others)
              : `<p class="muted small empty card-ish">${
                  favorites.length ? 'Other foods you scan, snap or save appear here.' : 'Foods you scan, snap or save will appear here, ready to log again in one tap.'
                }</p>`
          }`;
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

function ingredientList(food) {
  if (!food.ingredients?.length) return '';
  return `<ul class="ingredients">${food.ingredients
    .map((i) => `<li>${esc(i.name)}${i.amount ? ` · ${esc(i.amount)}` : ''} · ${fmt(i.kcal)} kcal</li>`)
    .join('')}</ul>`;
}

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
        ${ingredientList(food)}
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
        <button class="link fav-toggle"></button>
        <button class="link edit-food">Edit food details</button>`;

      const favBtn = $('.fav-toggle', body);
      const drawFav = () => (favBtn.textContent = food.favorite ? '★ In favorites (tap to remove)' : '☆ Add to favorites');
      drawFav();
      favBtn.onclick = async () => {
        food.favorite = !food.favorite;
        await saveFood(food);
        drawFav();
        toast(food.favorite ? 'Added to favorites' : 'Removed from favorites');
      };

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
        ${food.ingredients?.length ? `<div class="group-label">Made of</div>${ingredientList(food)}` : ''}
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
            parseMeal({
              apiKey: state.settings.apiKey,
              model: state.settings.model,
              text: text.trim(),
              foods: state.foods,
              home: state.settings.home,
              onProgress: (msg) => (go.textContent = msg),
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
              home: state.settings.home,
              onProgress: (msg) => (go.textContent = msg),
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
  // Restaurant dishes that were looked up are worth keeping, so next time needs no search.
  if (result.researched) rows.forEach((r) => r.kind === 'est' && (r.save = true));
  const sources = (result.sources || []).filter((s) => /^https?:\/\//i.test(s.url));
  let combo = false;
  let comboName = '';
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
        ${
          sources.length
            ? `<p class="muted small sources">Sources: ${sources
                .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`)
                .join(' · ')}</p>`
            : ''
        }
        <div class="review-list">${rows.map(rowHtml).join('')}</div>
        <div class="total"></div>
        <div class="combo-box">
          <label class="check"><input type="checkbox" class="combo" ${combo ? 'checked' : ''}> Save as a favorite, to log it in one tap next time</label>
          <input class="combo-name" type="text" autocomplete="off" placeholder="Name it, e.g. Post-workout shake" value="${esc(comboName)}" ${combo ? '' : 'hidden'}>
        </div>
        ${mealSelect(meal)}
        <button class="btn primary add">Add to diary</button>`;

      const comboBox = $('.combo', body);
      const comboInput = $('.combo-name', body);
      comboBox.addEventListener('change', () => {
        combo = comboBox.checked;
        comboInput.hidden = !combo;
        if (combo) comboInput.focus();
        update();
      });
      comboInput.addEventListener('input', () => (comboName = comboInput.value));

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
        $('.add', body).textContent = combo ? 'Add and save favorite' : `Add ${rows.length} item${rows.length === 1 ? '' : 's'}`;
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

      const estFood = (r) =>
        saveFood({
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

      $('.add', body).onclick = async () => {
        const mealSel = val(body, 'meal');

        if (combo) {
          // Save the whole meal as one favorite and log it as a single entry.
          const name = comboName.trim();
          if (!name) return toast('Give your favorite a name');
          const parts = rows
            .filter((r) => r.kind === 'est' || r.qty > 0)
            .map((r) =>
              r.kind === 'food'
                ? {
                    name: r.food.name,
                    amount: amountText(r.food, r.qty, r.unitKey),
                    grams: gramsOf(r.food, r.qty, r.unitKey),
                    ...scale(r.food, r.qty, r.unitKey),
                    estimate: r.food.source === 'ai' || !!r.food.estimated,
                  }
                : {
                    name: r.name || 'Food',
                    amount: r.grams ? `≈ ${fmt(r.grams)} g` : '',
                    grams: r.grams || null,
                    kcal: r.kcal,
                    protein: r.protein,
                    carbs: r.carbs,
                    fat: r.fat,
                    estimate: r.confidence !== 'high',
                  },
            );
          for (const r of rows) if (r.kind === 'est' && r.save) await estFood(r);
          const fav = await saveFavoriteMeal(name, parts);
          await addEntry(foodEntry(fav, 1, 'per', mealSel));
          await touchFood(fav, 1, 'per');
          return afterLog(`Added "${name}" and saved it to favorites`);
        }

        for (const r of rows) {
          if (r.kind === 'food') {
            if (!(r.qty > 0)) continue;
            await addEntry(foodEntry(r.food, r.qty, r.unitKey, mealSel));
            await touchFood(r.food, r.qty, r.unitKey);
          } else if (r.save) {
            const food = await estFood(r);
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

function timeAgo(t) {
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? `today at ${time}`
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

function cloudStatusText() {
  const s = cloud.status;
  if (s.busy) return 'Backing up…';
  if (s.error) return `Last backup failed: ${s.error}`;
  if (cloud.isDirty()) return 'Changes waiting to be backed up…';
  if (!s.lastSaved) return 'Not backed up yet.';
  return `Last backed up ${timeAgo(s.lastSaved)}.`;
}

function onCloudStatus() {
  renderToday();
  const el = $('.cloud-status');
  if (el) {
    el.textContent = cloudStatusText();
    el.classList.toggle('error', !!cloud.status.error);
  }
}

function cloudSection() {
  const c = state.settings.cloud;
  if (c) {
    return `
      <h4 class="section-label">Automatic backup (GitHub)</h4>
      <p class="small">Saving to the private repository <b>${esc(c.repo)}</b> a few seconds after every change.</p>
      <p class="small cloud-status muted">${esc(cloudStatusText())}</p>
      <div class="two"><button class="btn secondary cloud-now">Back up now</button><button class="btn secondary cloud-restore">Restore</button></div>
      <button class="link cloud-token">Replace token</button>
      <button class="link cloud-off">Turn off automatic backup</button>`;
  }
  return `
    <h4 class="section-label">Automatic backup (GitHub)</h4>
    <p class="muted small">Saves your diary to a <b>private</b> GitHub repository after every change, so it survives a lost or new phone. On a new phone, connect the same repository to get everything back.</p>
    <label class="field"><span>Private repository</span><input name="ghRepo" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="your-username/tally-data"></label>
    <label class="field"><span>Access token</span><input name="ghToken" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="github_pat_…"></label>
    <button class="btn secondary cloud-connect">Connect</button>
    <p class="small cloud-msg"></p>`;
}

function bindCloudSection(body, self) {
  $('.cloud-connect', body)?.addEventListener('click', async (ev) => {
    const msg = $('.cloud-msg', body);
    msg.classList.remove('error');
    const conf = { repo: cloud.normaliseRepo(val(body, 'ghRepo')), token: val(body, 'ghToken') };
    if (!conf.repo || !conf.token) return (msg.textContent = 'Enter both the repository and the token.');
    try {
      const remote = await busy(ev.currentTarget, 'Connecting…', async () => {
        await cloud.testConnection(conf);
        return cloud.fetchRemote(conf);
      });
      state.settings.cloud = conf;
      cloud.setConfig(conf);
      await saveSettings();
      if (isBackup(remote)) {
        // Connecting on a new phone: bring the saved diary back first, then save the combined copy.
        await importData(remote);
        const n = remote.entries.length;
        toast(`Restored ${n} diary ${n === 1 ? 'entry' : 'entries'} from GitHub`);
      }
      await cloud.saveNow();
      if (isTop(self)) showScreen();
    } catch (err) {
      msg.classList.add('error');
      msg.textContent = err.message;
    }
  });

  $('.cloud-now', body)?.addEventListener('click', async (ev) => {
    await busy(ev.currentTarget, 'Backing up…', () => cloud.saveNow());
    toast(cloud.status.error ? 'Backup failed' : 'Backed up to GitHub');
  });

  $('.cloud-restore', body)?.addEventListener('click', async (ev) => {
    try {
      const remote = await busy(ev.currentTarget, 'Loading…', () => cloud.fetchRemote());
      if (!isBackup(remote)) return toast('There is no backup on GitHub yet');
      if (!confirm(`Restore ${remote.foods.length} foods and ${remote.entries.length} diary entries from GitHub? Matching items are updated; nothing is deleted.`)) return;
      await importData(remote);
      toast('Restored from GitHub');
    } catch (err) {
      toast(err.message);
    }
  });

  $('.cloud-token', body)?.addEventListener('click', async () => {
    const token = prompt('Paste your new GitHub access token')?.trim();
    if (!token) return;
    const conf = { ...state.settings.cloud, token };
    try {
      await cloud.testConnection(conf);
    } catch (err) {
      return toast(err.message);
    }
    state.settings.cloud = conf;
    cloud.setConfig(conf);
    await saveSettings();
    await cloud.saveNow();
    toast(cloud.status.error ? 'Backup failed' : 'Token replaced and backed up');
  });

  $('.cloud-off', body)?.addEventListener('click', async () => {
    if (!confirm('Stop backing up to GitHub? The backup already in your repository is kept.')) return;
    state.settings.cloud = null;
    cloud.setConfig(null);
    await saveSettings();
    renderToday();
    if (isTop(self)) showScreen();
  });
}

function settingsScreen() {
  const self = {
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
        <label class="field"><span>Home city (helps find restaurants you mention)</span><input name="home" type="text" autocomplete="off" placeholder="e.g. Toronto, Ontario" value="${esc(s.home || '')}"></label>

        <button class="btn primary save">Save settings</button>

        ${cloudSection()}

        <h4 class="section-label">Backup file</h4>
        <p class="muted small">Save a copy of your diary as a file, e.g. to iCloud Drive. Keys and tokens are never included.</p>
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
        s.home = val(body, 'home');
        s.goalsSet = true;
        await saveSettings();
        renderToday();
        toast('Settings saved');
        back();
      };

      bindCloudSection(body, self);
      $('.export', body).onclick = exportBackup;
      $('.file-btn input', body).addEventListener('change', async (ev) => {
        const file = ev.target.files[0];
        ev.target.value = '';
        if (file) importBackup(file);
      });

      $('.wipe', body).onclick = async () => {
        const note = cloud.connected() ? ' The GitHub backup will be emptied too (older versions stay in the repository history).' : '';
        if (!confirm(`Delete ALL foods and diary entries from this phone? This cannot be undone. (Settings are kept.)${note}`)) return;
        await db.clear('entries');
        await db.clear('foods');
        state.foods = [];
        await refreshToday();
        toast('All data deleted');
      };
    },
  };
  return self;
}

// The backup contents (used for both the file export and the GitHub backup).
async function buildBackup() {
  return {
    app: 'tally',
    version: 1,
    exportedAt: new Date().toISOString(),
    goals: state.settings.goals,
    model: state.settings.model,
    foods: await db.all('foods'),
    entries: await db.all('entries'),
  };
}

const isBackup = (d) => d?.app === 'tally' && Array.isArray(d.foods) && Array.isArray(d.entries);

// Merges a backup into this phone: matching items are updated, nothing is deleted.
async function importData(data) {
  await db.putMany('foods', data.foods);
  await db.putMany('entries', data.entries);
  if (data.goals) {
    state.settings.goals = { ...state.settings.goals, ...data.goals };
    state.settings.goalsSet = true;
    await saveSettings();
  }
  await loadFoods();
  await refreshToday();
}

async function exportBackup() {
  const data = await buildBackup();
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
  if (!isBackup(data)) return toast("That file isn't a Tally backup.");
  if (!confirm(`Import ${data.foods.length} foods and ${data.entries.length} diary entries? Matching items will be updated; nothing else is deleted.`)) return;
  await importData(data);
  closeSheet();
  toast('Backup imported');
}

// ---------- start ----------

async function init() {
  await loadSettings();
  cloud.init({ getData: buildBackup, onStatus: onCloudStatus });
  cloud.setConfig(state.settings.cloud);
  db.onWrite(() => cloud.scheduleSave());
  await loadFoods();
  await refreshToday();
  if (cloud.isDirty()) cloud.saveNow(); // changes left unsaved last time
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});

  window.addEventListener('pagehide', () => cloud.flush());

  document.addEventListener('visibilitychange', async () => {
    // Leaving the app: save any pending changes straight away.
    if (document.visibilityState === 'hidden') return cloud.flush();
    // Reopening the app on a new day jumps to the new day.
    const t = todayStr();
    if (t === state.today) return;
    if (state.date === state.today) state.date = t;
    state.today = t;
    await refreshToday();
  });
}

init();
