// Claude calls, made straight from the phone with the user's own API key (no server).
import Anthropic from '../vendor/anthropic-sdk.js';
import { round1, unitLabel } from './nutrition.js';

export const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 · cheapest (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 · better photos, ~20× cost' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5 · most capable, ~40× cost' },
];
export const DEFAULT_MODEL = MODELS[0].id;

const LABEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'brand', 'serving_label', 'serving_grams', 'kcal', 'protein', 'carbs', 'fat', 'package_grams', 'notes'],
  properties: {
    name: { type: 'string' },
    brand: { type: 'string' },
    serving_label: { type: 'string' },
    serving_grams: { type: 'number' },
    kcal: { type: 'number' },
    protein: { type: 'number' },
    carbs: { type: 'number' },
    fat: { type: 'number' },
    package_grams: { type: 'number' },
    notes: { type: 'string' },
  },
};

const MEAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items', 'note'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'matched_food_id', 'quantity', 'unit', 'grams', 'kcal', 'protein', 'carbs', 'fat', 'confidence'],
        properties: {
          name: { type: 'string' },
          matched_food_id: { type: 'string' },
          quantity: { type: 'number' },
          unit: { type: 'string' },
          grams: { type: 'number' },
          kcal: { type: 'number' },
          protein: { type: 'number' },
          carbs: { type: 'number' },
          fat: { type: 'number' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
    note: { type: 'string' },
  },
};

const LABEL_SYSTEM = `You read photos of food packaging and copy the nutrition facts exactly as printed.
- Report calories, protein, carbohydrate and fat for the serving size printed on the label. If the label only gives values per 100 g (or 100 ml), use that and set serving_label to "100 g".
- serving_label: a short description of that serving, e.g. "1 cup" or "1/2 tray" (leave the weight out of it).
- serving_grams: the weight of that serving in grams if printed (for ml use the same number), otherwise 0.
- package_grams: the net weight of the whole package if visible, otherwise 0.
- If energy is only given in kJ, convert to kcal (divide by 4.184).
- If a value is not visible, use 0 and mention it in notes.
- name: a short, recognisable product name, e.g. "Kirkland bulgogi with jasmine rice". If the user says what it is, prefer their wording. brand: the brand, or "".
- notes: one short sentence about anything uncertain, or "".`;

const MEAL_SYSTEM = `You help log food to a personal calorie diary. Split what the user ate into separate food items.

The user's saved foods are listed with an id, their nutrition for a reference amount ("per"), and the units they can be logged in:
- per = the reference amount, g = grams, package = the whole package.
When an item clearly refers to a saved food, set matched_food_id to its id and express the amount as quantity + unit, where unit is "per", "g" or "package" (only units listed for that food). Fractions like "half the tray" mean quantity 0.5 with unit "package". Also fill grams with your best estimate of the weight eaten (0 if unknowable).
Otherwise set matched_food_id to "" and estimate a typical portion in grams if no amount is given. For branded or restaurant items, use their typical published nutrition values.

Always fill kcal, protein, carbs and fat (in grams) for the amount eaten; for saved foods, calculate them from the saved nutrition.
confidence: "high" = saved food or exact amount of a well-known food; "medium" = common food with a clear amount; "low" = portion or recipe guessed.
Keep names short (e.g. "Jasmine rice"). note: one short sentence stating the main assumption you made, or "".`;

const PHOTO_EXTRA = `
The user sent a photo of their meal. Identify each food you can see and estimate each portion from visual cues (a dinner plate is about 26 cm across; a fork about 19 cm). Include visible sauces, dressings and drinks. Do not invent foods you cannot see. If the user adds a note, it overrides what you see.`;

function foodList(foods) {
  if (!foods.length) return 'Saved foods: (none yet)';
  const recent = [...foods].sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0)).slice(0, 150);
  const lines = recent.map((f) => {
    const units = ['per', ...(f.per.grams ? ['g'] : []), ...(f.per.grams && f.packageGrams ? ['package'] : [])]
      .map((k) => (k === 'per' ? `per = ${unitLabel(f, 'per')}` : k === 'package' ? `package = ${round1(f.packageGrams)} g` : 'g'))
      .join(', ');
    const name = f.brand ? `${f.name} (${f.brand})` : f.name;
    return `${f.id} | ${name} | per ${unitLabel(f, 'per')}: ${f.kcal} kcal, protein ${f.protein} g, carbs ${f.carbs} g, fat ${f.fat} g | units: ${units}`;
  });
  return `Saved foods:\n${lines.join('\n')}`;
}

function imageBlock(img) {
  return { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } };
}

export async function readLabel({ apiKey, model, images, hint }) {
  const content = [
    ...images.map(imageBlock),
    { type: 'text', text: hint ? `The user says this is: ${hint}` : 'Read the nutrition label in these photos.' },
  ];
  return callJSON({ apiKey, model, system: LABEL_SYSTEM, content, schema: LABEL_SCHEMA, effort: 'low' });
}

export async function parseMeal({ apiKey, model, text, image, foods }) {
  const content = [];
  if (image) content.push(imageBlock(image));
  content.push({
    type: 'text',
    text: `${foodList(foods)}\n\n${image ? 'Note from the user about the photo' : 'What I ate'}: ${text || '(no note)'}`,
  });
  return callJSON({
    apiKey,
    model,
    system: image ? MEAL_SYSTEM + PHOTO_EXTRA : MEAL_SYSTEM,
    content,
    schema: MEAL_SCHEMA,
    effort: image ? 'medium' : 'low',
  });
}

export async function testKey({ apiKey, model }) {
  try {
    await client(apiKey).messages.create({
      model,
      max_tokens: 256,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with the word OK.' }],
    });
  } catch (err) {
    throw friendlyError(err);
  }
}

function client(apiKey) {
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 90_000, maxRetries: 1 });
}

async function callJSON({ apiKey, model, system, content, schema, effort }) {
  const c = client(apiKey);
  const base = { model, max_tokens: 8000, system, messages: [{ role: 'user', content }] };
  let resp;
  try {
    resp = await c.messages.create({ ...base, output_config: { effort, format: { type: 'json_schema', schema } } });
  } catch (err) {
    // If a model ever rejects structured outputs or effort, retry with plain JSON instructions.
    if (err?.status !== 400 || !/output_config|format|schema|effort/i.test(err?.message || '')) throw friendlyError(err);
    try {
      resp = await c.messages.create({
        ...base,
        system: `${system}\n\nReply with only a JSON object that matches this JSON Schema, and no other text:\n${JSON.stringify(schema)}`,
      });
    } catch (err2) {
      throw friendlyError(err2);
    }
  }
  if (resp.stop_reason === 'refusal') throw new Error('Claude declined this request. Try describing it differently.');
  if (resp.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try a shorter description.');
  const text = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('Claude sent back something unexpected. Please try again.');
  }
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  const status = err?.status;
  if (status === 401) return new Error('Your Claude API key was rejected. Check it in Settings.');
  if (status === 400 && /credit/i.test(msg)) return new Error('Your Anthropic account is out of credit. Add some at console.anthropic.com.');
  if (status === 403) return new Error('This API key is not allowed to use that model. Pick another model in Settings.');
  if (status === 404) return new Error('That Claude model was not found. Pick another model in Settings.');
  if (status === 429) return new Error('Too many requests right now. Wait a moment and try again.');
  if (status === 529 || status >= 500) return new Error('Claude is busy right now. Try again in a minute.');
  if (!status) return new Error("Couldn't reach Claude. Check your internet connection.");
  return new Error(msg);
}
