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
  required: ['items', 'note', 'lookup_query'],
  properties: {
    lookup_query: { type: 'string' },
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
Foods marked [favorite] are meals the user has regularly; phrases like "my usual breakfast", "my shake" or "the yogurt bowl" usually mean one of them, and one favorite is a single item (don't split it into its ingredients).
When an item clearly refers to a saved food, set matched_food_id to its id and express the amount as quantity + unit, where unit is "per", "g" or "package" (only units listed for that food). Fractions like "half the tray" mean quantity 0.5 with unit "package". Also fill grams with your best estimate of the weight eaten (0 if unknowable).
Otherwise set matched_food_id to "" and estimate a typical portion in grams if no amount is given. For branded or restaurant items, use their typical published nutrition values.

Always fill kcal, protein, carbs and fat (in grams) for the amount eaten; for saved foods, calculate them from the saved nutrition.
confidence: "high" = saved food or exact amount of a well-known food; "medium" = common food with a clear amount; "low" = portion or recipe guessed.
Keep names short (e.g. "Jasmine rice"); name restaurant dishes "Dish (Restaurant)", e.g. "Bone marrow burger (Bar Isabel)". note: one short sentence stating the main assumption you made, or "".`;

const LOOKUP_RULE = `
lookup_query: if the user names a specific restaurant, café, bakery, food truck or other food business (other than a large chain whose menu nutrition you know well), and that item is not one of their saved foods, write a short web search query that would find the dish on that place's menu, including the city, e.g. "Bar Isabel Toronto bone marrow burger menu". Otherwise "".`;

const RESEARCHED_RULE = `
Web research about the restaurant items is included above, so set lookup_query to "".
If the research gives published nutrition, use it. Otherwise estimate from the dish's described ingredients, sides and size, assuming a restaurant portion: restaurant dishes are usually larger and richer than home-made versions, so count cooking fat, butter, sauces, cheese, buns and sides. In note, name the restaurant and say whether the numbers are published or estimated.`;

const homeLine = (home) =>
  home ? `\nThe user lives in ${home}. Restaurants, streets and intersections they mention are most likely there.` : '';

const researchSystem = (home) => `You help someone log restaurant meals in their calorie diary.${homeLine(home)}
Use web search to identify the exact restaurant they mean, matching the name and any location hint (street, intersection, neighbourhood) and preferring locations in or near their home city. Then find the dish on that restaurant's menu.
Reply briefly in plain text, for each dish:
- Restaurant: name and address or area
- Dish: its name on the menu, the menu description, listed ingredients and sides
- Size: any portion, weight or patty-size clues
- Nutrition: calories and macros only if the restaurant or a reliable source publishes them, otherwise "not published"
If you can't find the exact dish, say so and describe the closest match. Don't estimate calories yourself.`;

const PHOTO_EXTRA = `
The user sent a photo of their meal. Identify each food you can see and estimate each portion from visual cues (a dinner plate is about 26 cm across; a fork about 19 cm). Include visible sauces, dressings and drinks. Do not invent foods you cannot see. If the user adds a note, it overrides what you see.`;

function foodList(foods) {
  if (!foods.length) return 'Saved foods: (none yet)';
  const recent = [...foods].sort((a, b) => (b.lastUsed || b.createdAt || 0) - (a.lastUsed || a.createdAt || 0)).slice(0, 150);
  const lines = recent.map((f) => {
    const units = ['per', ...(f.per.grams ? ['g'] : []), ...(f.per.grams && f.packageGrams ? ['package'] : [])]
      .map((k) => (k === 'per' ? `per = ${unitLabel(f, 'per')}` : k === 'package' ? `package = ${round1(f.packageGrams)} g` : 'g'))
      .join(', ');
    let name = f.brand ? `${f.name} (${f.brand})` : f.name;
    if (f.favorite) name += ' [favorite]';
    if (f.ingredients?.length) name += ` [made of: ${f.ingredients.map((i) => i.name).join(', ')}]`;
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

// Works out what was eaten. If it mentions a restaurant Claude doesn't know, it first looks
// the dish up on the web, then works out the numbers again using what it found.
export async function parseMeal({ apiKey, model, text, image, foods, home, onProgress }) {
  const run = (research) => {
    const content = [];
    if (image) content.push(imageBlock(image));
    content.push({
      type: 'text',
      text: [
        foodList(foods),
        research ? `Web research about the restaurant items:\n${research.text}` : '',
        `${image ? 'Note from the user about the photo' : 'What I ate'}: ${text || '(no note)'}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    return callJSON({
      apiKey,
      model,
      system: MEAL_SYSTEM + homeLine(home) + (image ? PHOTO_EXTRA : '') + (research ? RESEARCHED_RULE : LOOKUP_RULE),
      content,
      schema: MEAL_SCHEMA,
      effort: image || research ? 'medium' : 'low',
    });
  };

  const first = await run(null);
  if (!first.lookup_query?.trim() || !text?.trim()) return { ...first, sources: [] };

  onProgress?.('Looking up the restaurant…');
  let research;
  try {
    research = await researchMeal({ apiKey, model, text, query: first.lookup_query, home });
  } catch (err) {
    return { ...first, sources: [], note: `Couldn't look up the restaurant (${err.message}). ${first.note}`.trim() };
  }
  if (!research.text) return { ...first, sources: [] };
  onProgress?.('Working out the numbers…');
  return { ...(await run(research)), sources: research.sources, researched: true };
}

// Searches the web for the restaurant and dish. Returns { text, sources: [{ url, title }] }.
async function researchMeal({ apiKey, model, text, query, home }) {
  const c = client(apiKey);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [city, region] = (home || '').split(',').map((s) => s.trim());
  const userLocation = { type: 'approximate', ...(city && { city }), ...(region && { region }), ...(timezone && { timezone }) };
  const tool = (type) => ({ type, name: 'web_search', max_uses: 3, user_location: userLocation });
  const messages = [{ role: 'user', content: `What I ate: ${text}\nSuggested search: ${query}` }];

  let toolType = 'web_search_20260209';
  const responses = [];
  for (let turn = 0; turn < 4; turn++) {
    let resp;
    try {
      resp = await c.messages.create({
        model,
        max_tokens: 8000,
        system: researchSystem(home),
        messages,
        tools: [tool(toolType)],
        output_config: { effort: 'low' },
      });
    } catch (err) {
      // Older models only have the basic search tool.
      if (err?.status === 400 && toolType === 'web_search_20260209' && /web_search_20260209|tool type|not supported/i.test(err.message || '')) {
        toolType = 'web_search_20250305';
        turn--;
        continue;
      }
      throw friendlyError(err);
    }
    responses.push(resp);
    if (resp.stop_reason === 'refusal') throw new Error('Claude declined to look this up.');
    if (resp.stop_reason !== 'pause_turn') break;
    // A long search turn was paused; send it back unchanged so the server carries on.
    messages.push({ role: 'assistant', content: resp.content });
  }

  const blocks = responses.flatMap((r) => r.content);
  const sources = new Map();
  for (const b of blocks) {
    for (const cite of b.citations || []) if (cite.url) sources.set(cite.url, cite.title || cite.url);
  }
  if (!sources.size) {
    for (const b of blocks) {
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) sources.set(r.url, r.title || r.url);
      }
    }
  }
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
    sources: [...sources].slice(0, 4).map(([url, title]) => ({ url, title })),
  };
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
  if (status === 400 && /web search.*not enabled|not enabled.*web search/i.test(msg))
    return new Error('Web search is switched off for your Anthropic account (Console → Settings → Capabilities).');
  if (status === 403) return new Error('This API key is not allowed to use that model. Pick another model in Settings.');
  if (status === 404) return new Error('That Claude model was not found. Pick another model in Settings.');
  if (status === 429) return new Error('Too many requests right now. Wait a moment and try again.');
  if (status === 529 || status >= 500) return new Error('Claude is busy right now. Try again in a minute.');
  if (!status) return new Error("Couldn't reach Claude. Check your internet connection.");
  return new Error(msg);
}
