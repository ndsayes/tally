// Food maths. A food stores calories and macros for one reference amount (`per`),
// e.g. { label: '1 cup', grams: 250 } or { label: '100 g', grams: 100 } or
// { label: '1 cookie', grams: null } when the weight is unknown.
// Optional `packageGrams` lets you log "half the tray".

export const MEALS = ['breakfast', 'lunch', 'dinner', 'snacks'];
export const MEAL_NAMES = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snacks: 'Snacks' };

export const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export function mealForNow(d = new Date()) {
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 10.5) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h >= 17 && h < 21.5) return 'dinner';
  return 'snacks';
}

// The units a food can be logged in. 'per' = the food's own reference amount.
export function unitsFor(food) {
  const g = food.per?.grams;
  const units = [{ key: 'per', grams: g || null }];
  if (g) units.push({ key: 'g', grams: 1 });
  if (g && food.packageGrams) units.push({ key: 'package', grams: food.packageGrams });
  return units;
}

export function unitLabel(food, key) {
  if (key === 'g') return 'grams';
  if (key === 'package') return `package (${round1(food.packageGrams)} g)`;
  const { label, grams } = food.per;
  return grams && !/\d\s*g\b/i.test(label) ? `${label} (${round1(grams)} g)` : label;
}

export function scale(food, qty, unitKey) {
  const unit = unitsFor(food).find((u) => u.key === unitKey) ?? unitsFor(food)[0];
  const factor = unit.key === 'per' ? qty : (qty * unit.grams) / food.per.grams;
  return {
    kcal: Math.round((food.kcal || 0) * factor),
    protein: round1((food.protein || 0) * factor),
    carbs: round1((food.carbs || 0) * factor),
    fat: round1((food.fat || 0) * factor),
  };
}

const FRACTIONS = { 0.25: '¼', 0.33: '⅓', 0.5: '½', 0.67: '⅔', 0.75: '¾' };

export function amountText(food, qty, unitKey) {
  const q = round2(qty);
  if (unitKey === 'g') return `${q} g`;
  if (unitKey === 'package') return q === 1 ? 'whole package' : `${FRACTIONS[q] ?? q} package`;
  const label = unitLabel(food, 'per');
  return q === 1 ? label : `${FRACTIONS[q] ?? q} × ${label}`;
}

export function sumEntries(entries) {
  const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
  for (const e of entries) {
    t.kcal += e.kcal || 0;
    t.protein += e.protein || 0;
    t.carbs += e.carbs || 0;
    t.fat += e.fat || 0;
  }
  return t;
}
