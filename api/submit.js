// Vercel Serverless Function: /api/submit
// Receives an intake submission from the front-end, optionally enriches it with
// Claude extraction over a pasted message, then writes it to the Notion Projects DB.
// Files (PDFs and images) are uploaded to Notion's file_uploads API and attached
// to the page's "Original PDF" and "Photos" file properties.
//
// Required environment variables (set in Vercel project settings):
//   NOTION_API_KEY       - Notion internal integration token (starts with "ntn_")
//                          Either casing is tolerated.
//   ANTHROPIC_API_KEY    - Anthropic API key (only needed for message extraction)

const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const PROJECTS_DATABASE_ID = '2ff081ea37154987b3d68491451553ae';
const PROJECTS_DATA_SOURCE_ID = 'ccf41a90-55b9-44bd-92ff-9e014d767d0f';

// Env var lookup that tolerates either casing in Vercel.
const NOTION_KEY    = process.env.NOTION_API_KEY    || process.env.Notion_API_Key    || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.Anthropic_API_Key || '';

// Vercel body size limit is ~4.5MB. Cap incoming payloads (base64 inflates ~33%).
export const config = {
  api: {
    bodyParser: { sizeLimit: '4.5mb' },
  },
};

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
    const { mode, serial, form, message, files } = body;

    // Preview mode: return extracted JSON without saving to Notion.
    if (body.preview === true) {
      let fromMessage = {};
      let fromFiles = {};
      if (message && ANTHROPIC_KEY) {
        try { fromMessage = await extractFromMessage(message); }
        catch (e) { console.error('preview msg extract:', e.message); }
      }
      if (Array.isArray(files) && files.length > 0 && ANTHROPIC_KEY) {
        try { fromFiles = await extractFromFiles(files); }
        catch (e) { console.error('preview file extract:', e.message); }
      }
      return res.status(200).json({ ok: true, extracted: { ...fromMessage, ...fromFiles } });
    }

    if (!serial || !/^\d{4}$/.test(serial)) {
      return res.status(400).json({ error: 'serial must be a 4-digit string' });
    }
    if (!form || typeof form !== 'object') {
      return res.status(400).json({ error: 'form payload missing' });
    }

    coerceNumbers(form);

    // Optional extraction over a pasted message
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

    // Upload any files to Notion in parallel
    const fileUploads = await uploadFiles(files);

    // Optional: extract structured fields from uploaded files (PDFs, photos)
    if (Array.isArray(files) && files.length > 0 && ANTHROPIC_KEY) {
      try {
        const extracted = await extractFromFiles(files);
        for (const [k, v] of Object.entries(extracted)) {
          if (form[k] == null || form[k] === '') form[k] = v;
        }
      } catch (err) {
        console.error('file extraction failed (non-fatal):', err.message);
      }
    }

    if (mode === 'existing') {
      const result = await appendToExistingProject(serial, form, message, fileUploads);
      return res.status(200).json({ ok: true, ...result });
    } else {
      const result = await createNewProject(serial, form, message, fileUploads);
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
  const r = await fetch(`${NOTION_API_BASE}${path}`, {
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
    throw new Error(`Notion ${r.status} on ${path}: ${text.slice(0, 500)}`);
  }
  return r.json();
}

// --- File upload helpers ---

async function uploadFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const results = [];
  for (const f of files) {
    if (!f || !f.name || !f.data) continue;
    try {
      const uploadId = await uploadOneFile(f.name, f.type || 'application/octet-stream', f.data);
      results.push({
        uploadId,
        name: f.name,
        mimeType: f.type || '',
        isImage: (f.type || '').startsWith('image/'),
      });
    } catch (err) {
      console.error('file upload failed for', f.name, err.message);
    }
  }
  return results;
}

async function uploadOneFile(filename, mimeType, base64Data) {
  // Strip data URI prefix if present
  const cleanB64 = String(base64Data).replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(cleanB64, 'base64');

  // 1) Create upload session
  const session = await notionFetch('/file_uploads', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'single_part',
      filename,
      content_type: mimeType,
    }),
  });

  // 2) Send the binary
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mimeType }), filename);
  const sendRes = await fetch(`${NOTION_API_BASE}/file_uploads/${session.id}/send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': NOTION_VERSION,
    },
    body: fd,
  });
  if (!sendRes.ok) {
    const t = await sendRes.text();
    throw new Error(`file send ${sendRes.status}: ${t.slice(0, 200)}`);
  }

  return session.id;
}

function buildFileProperty(uploads) {
  return {
    files: uploads.map(u => ({
      name: u.name,
      type: 'file_upload',
      file_upload: { id: u.uploadId },
    })),
  };
}

// --- Notion page construction ---

function buildTitle(serial, form) {
  const muni = (form.municipality || '').trim();
  const state = (form.state || '').trim();
  const loc = [muni, state].filter(Boolean).join(', ');
  return loc ? `${serial} - ${loc}` : `${serial} - New submission`;
}

function buildProperties(serial, form, message, fileUploads) {
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

  // Route files: PDFs -> "Original PDF", everything else (treated as images) -> "Photos"
  if (Array.isArray(fileUploads) && fileUploads.length > 0) {
    const pdfs = fileUploads.filter(u => /pdf/i.test(u.mimeType));
    const photos = fileUploads.filter(u => !/pdf/i.test(u.mimeType));
    if (pdfs.length)   properties['Original PDF'] = buildFileProperty(pdfs);
    if (photos.length) properties['Photos']        = buildFileProperty(photos);
  }

  return properties;
}

async function createNewProject(serial, form, message, fileUploads) {
  const data = await notionFetch('/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { type: 'data_source_id', data_source_id: PROJECTS_DATA_SOURCE_ID },
      properties: buildProperties(serial, form, message, fileUploads),
    }),
  });
  return { pageId: data.id, url: data.url, serial, mode: 'new', filesAttached: fileUploads.length };
}

async function findProjectBySerial(serial) {
  const data = await notionFetch(`/data_sources/${PROJECTS_DATA_SOURCE_ID}/query`, {
    method: 'POST',
    body: JSON.stringify({
      filter: { property: 'Property Name', title: { starts_with: serial } },
      page_size: 1,
    }),
  });
  return data.results[0] || null;
}

async function appendToExistingProject(serial, form, message, fileUploads) {
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
    // Append any uploaded files as file/image blocks
    ...fileUploads.map(u => ({
      object: 'block',
      type: u.isImage ? 'image' : 'file',
      [u.isImage ? 'image' : 'file']: {
        type: 'file_upload',
        file_upload: { id: u.uploadId },
      },
    })),
  ];

  await notionFetch(`/blocks/${existing.id}/children`, {
    method: 'PATCH',
    body: JSON.stringify({ children }),
  });

  return { pageId: existing.id, url: existing.url, serial, mode: 'existing', filesAttached: fileUploads.length };
}

// --- Claude extraction ---

async function extractFromFiles(files) {
  const content = [];
  for (const f of files) {
    if (!f || !f.data) continue;
    const cleanB64 = String(f.data).replace(/^data:[^;]+;base64,/, '');
    const mt = (f.type || '').toLowerCase();
    if (mt.startsWith('image/')) {
      content.push({ type: 'image', source: { type: 'base64', media_type: mt, data: cleanB64 } });
    } else if (mt === 'application/pdf' || /\.pdf$/i.test(f.name || '')) {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: cleanB64 } });
    }
  }
  if (content.length === 0) return {};
  content.push({ type: 'text', text: 'Extract property fields from the attached documents. Output ONLY a JSON object.' });

  const sys = [
    'You extract real estate fields from photos and PDFs describing Mexican land parcels.',
    'Documents may be in Spanish or English. Common formats: property evaluation checklists (¿Cumple? Si/No tables), listing photos, technical sheets (FICHA TECNICA), WhatsApp screenshots, brochures.',
    'Output ONLY a JSON object. Use null for fields you cannot find with confidence. Never invent.',
    '',
    'Fields:',
    '- hunterName, hunterPhone, hunterEmail (the person submitting; usually NOT in the property doc; leave null)',
    '- state: full Mexican state name in Spanish. Valid options: Aguascalientes, Baja California, Baja California Sur, Campeche, Chiapas, Chihuahua, Ciudad de México, Coahuila, Colima, Durango, Estado de México, Guanajuato, Guerrero, Hidalgo, Jalisco, Michoacán, Morelos, Nayarit, Nuevo León, Oaxaca, Puebla, Querétaro, Quintana Roo, San Luis Potosí, Sinaloa, Sonora, Tabasco, Tamaulipas, Tlaxcala, Veracruz, Yucatán, Zacatecas',
    '- municipality: e.g. Zapotlán de Juárez, Salvatierra',
    '- googleMaps: a Maps URL if present. If only coordinates in DMS are shown (e.g. 19°57203.2"N 98°52215.8"W), convert to decimal and build https://maps.google.com/?q=LAT,LON',
    '- distance: distance to nearest urban center in km (number only)',
    '- landSizeHa: parcel size in hectares (1 ha = 10000 m²; convert if needed)',
    '- totalPrice: full asking price in MXN (number only, no commas/symbols)',
    '- pricePerM2: price per square meter in MXN (number only)',
    '- ownership: one of Private | Ejido | Communal | Unknown. Mapping: Privado/Particular->Private, Ejidal/Ejido->Ejido, Comunal->Communal',
    '- landUse: e.g. Habitacional, Agrícola, Comercial, Industrial, Mixto',
    '- utilities: array, subset of [Water, Electricity, Drainage, None, Unknown]. Mapping: agua->Water, luz/electricidad/corriente->Electricity, drenaje->Drainage',
    '',
    'Tips:',
    '- Evaluation sheets often have a "Cumple?" Si/No column AND an "Observaciones" column. The Observaciones column usually holds the actual VALUE (e.g. "Es un predio de 7.9 hectáreas" -> landSizeHa=7.9). Always read both columns.',
    '- If you see "$1,500 por m2" -> pricePerM2=1500. If you see "$118,500,000 pesos" -> totalPrice=118500000.',
    '- If you see 79,000 m2 -> landSizeHa=7.9 (divide by 10000).',
    '- Cross-check: if you find pricePerM2 and landSizeHa, totalPrice should be pricePerM2 * landSizeHa * 10000. Use this to validate.',
  ].join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: sys,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  const responseText = (data.content?.[0]?.text || '{}').trim();
  const jsonText = responseText.replace(/^```json\s*/, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(jsonText); } catch { return {}; }
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
