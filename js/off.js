// Barcode lookups against Open Food Facts (free, open data, ODbL licence).
import { round1 } from './nutrition.js';

// product_quantity is only returned when its unit/quantity fields are requested too.
const FIELDS =
  'code,product_name,brands,nutriments,serving_size,serving_quantity,serving_quantity_unit,product_quantity,product_quantity_unit,quantity';

// UPC-A (12 digits) and EAN-13 (13 digits, leading 0) are the same product number.
export function barcodeVariants(code) {
  const c = String(code).replace(/\D/g, '');
  const v = new Set([c]);
  if (c.length === 12) v.add('0' + c);
  if (c.length === 13 && c[0] === '0') v.add(c.slice(1));
  return [...v];
}

export function sameBarcode(a, b) {
  if (!a || !b) return false;
  const va = barcodeVariants(a);
  return barcodeVariants(b).some((x) => va.includes(x));
}

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
};

// Returns { complete, food } or null when the product is unknown.
// `complete` is false when the product exists but has no calorie data.
export async function lookupBarcode(code) {
  for (const c of barcodeVariants(code)) {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(c)}.json?fields=${FIELDS}`,
      { signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined },
    );
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`Open Food Facts returned an error (${res.status})`);
    const data = await res.json();
    if (data.status !== 1 || !data.product) continue;
    return toFood(data.product, String(code));
  }
  return null;
}

function toFood(p, code) {
  const n = p.nutriments || {};
  let kcal100 = num(n['energy-kcal_100g']);
  if (kcal100 == null && num(n['energy-kj_100g']) != null) kcal100 = num(n['energy-kj_100g']) / 4.184;
  if (kcal100 == null && num(n.energy_100g) != null) kcal100 = num(n.energy_100g) / 4.184; // energy_100g is kJ

  const servingG = num(p.serving_quantity);
  const pkgG = num(p.product_quantity);
  const food = {
    name: (p.product_name || '').trim() || 'Unnamed product',
    brand: (p.brands || '').split(',')[0].trim(),
    barcode: code,
    source: 'off',
    packageGrams: pkgG > 0 ? pkgG : null,
  };
  if (kcal100 == null) return { complete: false, food };

  // Prefer the label's serving size as the reference amount; fall back to 100 g.
  const base = servingG > 0 ? servingG : 100;
  const f = base / 100;
  food.per = {
    label: servingG > 0 ? (p.serving_size ? `1 serving (${p.serving_size})` : '1 serving') : '100 g',
    grams: round1(base),
  };
  food.kcal = Math.round(kcal100 * f);
  food.protein = round1((num(n.proteins_100g) ?? 0) * f);
  food.carbs = round1((num(n.carbohydrates_100g) ?? 0) * f);
  food.fat = round1((num(n.fat_100g) ?? 0) * f);
  return { complete: true, food };
}
