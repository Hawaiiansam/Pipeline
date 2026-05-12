// Vercel Serverless Function: /api/submit
// Receives an intake submission from the front-end, optionally enriches it with
// Claude extraction over a pasted message, then writes it to the Notion Projects DB.
//
// Required environment variables (set in Vercel project settings):
//   NOTION_API_KEY       - Notion internal integration token (starts with "secret_" or "ntn_")
//   ANTHROPIC_API_KEY    - Anthropic API key (only needed if you want message extraction)
//
// The Notion integration must be invited to the Projects database.

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const PROJECTS_DATABASE_ID = '2ff081ea37154987b3d68491451553ae';

// Env var lookup that tolerates either casing in Vercel.
const NOTION_KEY    = NOTION_KEY    || process.env.Notion_API_Key    || '';
const ANTHROPIC_KEY = ANTHROPIC_KEY || process.env.Anthropic_API_Key || '';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  if (!NOTION_KEY) {
    return res.status(500).json({ error: 'Server is missing NOTION_API_KEY.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { mode, serial, form, message } = body;

    if (!serial || !/^\d{4}$/.test(serial)) {
      return res.status(400).json({ error: 'serial must be a 4-digit string' });
    }
    if (!form || typeof form !== 'object') {
      return res.status(400).json({ error: 'form payload missing' });
    }

    // Normalize numbers (the frontend may send strings from <input type="number">)
    coerceNumbers(form);

    // Optional: enrich form with extracted data from pasted message.
    // Form fields always win; extracted only fills in blanks.
    if (message && ANTHROPIC_KEY) {
      try {
        const extracted = await extractFromMessage(message);
        for (const [k, v] of Object.entries(extracted)) {
          if (form[k] == null || form[k] === '') form[k] = v;
        }
      } catch (err) {
        console.error('extraction failed (non-fatal):', err.message);
      }
    }

    if (mode === 'existing') {
      const result = await appendToExistingProject(serial, form, message);
      return res.status(200).json({ ok: true, ...result });
    } else {
      const result = await createNewProject(serial, form, message);
      return res.status(200).json({ ok: true, ...result });
    }
  } catch (err) {
    console.error('submit failed:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
}

function coerceNumbers(form) {
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if ('distance' in form)    form.distance    = num(form.distance);
  if ('landSizeHa' in form)  form.landSizeHa  = num(form.landSizeHa);
  if ('pricePerM2' in form)  form.pricePerM2  = num(form.pricePerM2);
  if ('totalPrice' in form)  form.totalPrice  = num(form.totalPrice);
}

async function notionFetch(path, options = {}) {
  const url = `${NOTION_API_BASE}${path}`;
  const r = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Notion ${r.status}: ${text.slice(0, 500)}`);
  }
  return r.json();
}

function buildTitle(serial, form) {
  const muni = (form.municipality || '').trim();
  const state = (form.state || '').trim();
  const loc = [muni, state].filter(Boolean).join(', ');
  return loc ? `${serial} - ${loc}` : `${serial} - New submission`;
}

function buildProperties(serial, form, message) {
  const properties = {
    'Property Name': { title: [{ text: { content: buildTitle(serial, form) } }] },
    'Intake Source': { select: { name: 'Form' } },
    'Project Phase': { select: { name: 'Initial Review' } },
    'Source':        { select: { name: 'Hunter Network' } },
  };

  if (form.hunterPhone) properties['Hunter Phone']  = { phone_number: String(form.hunterPhone) };
  if (form.hunterEmail) properties['Hunter Email']  = { email: String(form.hunterEmail) };
  if (form.state)        properties['State']         = { select: { name: form.state } };
  if (form.municipality) properties['Municipality']  = { rich_text: [{ text: { content: form.municipality } }] };
  if (form.googleMaps)   properties['Google Maps Link'] = { url: form.googleMaps };
  if (Number.isFinite(form.distance))   properties['Distance to Urban Center (km)'] = { number: form.distance };
  if (Number.isFinite(form.landSizeHa)) properties['Estimated Land Size (Ha)'] = { number: form.landSizeHa };
  if (Number.isFinite(form.totalPrice)) properties['Estimated Land Value (MXN)'] = { number: form.totalPrice };
  if (form.ownership)    properties['Ownership Regime'] = { select: { name: form.ownership } };
  if (form.landUse)      properties['Land Use'] = { rich_text: [{ text: { content: form.landUse } }] };
  if (Array.isArray(form.utilities) && form.utilities.length > 0) {
    properties['Utilities Available'] = { multi_select: form.utilities.map(u => ({ name: u })) };
  }

  const noteParts = [];
  if (form.hunterName)  noteParts.push(`Hunter: ${form.hunterName}`);
  if (form.hunterNotes) noteParts.push(form.hunterNotes);
  if (message)          noteParts.push(`--- Pasted message ---\n${message}`);
  if (noteParts.length) {
    properties['Hunter Notes'] = { rich_text: [{ text: { content: noteParts.join('\n\n').slice(0, 1900) } }] };
  }

  return properties;
}

async function createNewProject(serial, form, message) {
  const data = await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: PROJECTS_DATABASE_ID },
      properties: buildProperties(serial, form, message),
    }),
  });
  return { pageId: data.id, url: data.url, serial, mode: 'new' };
}

async function findProjectBySerial(serial) {
  const data = await notionFetch(`/databases/${PROJECTS_DATABASE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: {
        property: 'Property Name',
        title: { starts_with: serial },
      },
      page_size: 1,
    }),
  });
  return data.results[0] || null;
}

async function appendToExistingProject(serial, form, message) {
  const existing = await findProjectBySerial(serial);
  if (!existing) {
    throw new Error(`No project found with serial ${serial}.`);
  }

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [];
  if (form.hunterName) lines.push(`From: ${form.hunterName}${form.hunterPhone ? ` (${form.hunterPhone})` : ''}`);

  const fields = [
    ['Municipality',                  form.municipality],
    ['State',                         form.state],
    ['Land size (ha)',                form.landSizeHa],
    ['Total price (MXN)',             form.totalPrice],
    ['Ownership',                     form.ownership],
    ['Land use',                      form.landUse],
    ['Distance to urban center (km)', form.distance],
    ['Google Maps',                   form.googleMaps],
    ['Utilities',                     Array.isArray(form.utilities) ? form.utilities.join(', ') : null],
    ['Hunter notes',                  form.hunterNotes],
  ];
  for (const [k, v] of fields) {
    if (v != null && v !== '') lines.push(`${k}: ${v}`);
  }
  if (message) {
    lines.push('');
    lines.push('Pasted message:');
    lines.push(message);
  }

  const children = [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: { rich_text: [{ text: { content: `Update ${ts}` } }] },
    },
    ...lines.map(line => ({
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ text: { content: (line || ' ').slice(0, 1900) } }] },
    })),
  ];

  await notionFetch(`/blocks/${existing.id}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children }),
  });

  return { pageId: existing.id, url: existing.url, serial, mode: 'existing' };
}

async function extractFromMessage(text) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: [
        'You extract structured fields from a free-text message describing a Mexican real estate parcel.',
        'The message may be in Spanish or English. Output ONLY a JSON object, no prose.',
        'Fields (use null when unknown, never invent):',
        '  hunterName (string), hunterPhone (string), hunterEmail (string),',
        '  state (full Mexican state name, e.g. "Guanajuato"),',
        '  municipality (string), googleMaps (URL), distance (km, number),',
        '  landSizeHa (hectares, number), totalPrice (MXN, number),',
        '  ownership (one of: Private, Ejido, Communal, Unknown),',
        '  landUse (string),',
        '  utilities (array, subset of: Water, Electricity, Drainage, None, Unknown).',
      ].join(' '),
      messages: [{ role: 'user', content: text }],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const content = (data.content?.[0]?.text || '{}').trim();
  const jsonText = content.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return {};
  }
}
