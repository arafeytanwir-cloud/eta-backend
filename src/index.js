// ═══════════════════════════════════════════════════════════════
// eTA Backend — Worker
// Routes:
//   POST /api/stage            — frontend stages full form data pre-payment (writes to KV, not Airtable)
//   POST /webhook/orders-paid  — Shopify calls this after payment; verifies HMAC, pulls staged data, writes to Airtable
//   POST /submit               — legacy direct-write route, kept for admin/fallback use only
// ═══════════════════════════════════════════════════════════════

const STAGE_TTL_SECONDS = 60 * 60 * 48; // 48 hours

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ success: false, error: 'Method not allowed. Use POST.' }, 405);
    }

    if (url.pathname === '/api/stage') {
      return handleStage(request, env);
    }

    if (url.pathname === '/webhook/orders-paid') {
      return handleOrdersPaidWebhook(request, env);
    }

    // Legacy / fallback direct-write route
    return handleDirectSubmit(request, env);
  }
};

// ── Route: /api/stage ──────────────────────────────────────────
// Frontend calls this right before redirecting to checkout.
// Stores the full form payload in KV, returns a short applicationId
// to be tucked into the cart as a line-item property.
async function handleStage(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const validationError = validateApplication(data);
  if (validationError) {
    return jsonResponse({ success: false, error: validationError }, 400);
  }

  const applicationId = crypto.randomUUID();

  try {
    await env.APPLICATION_STORE.put(
      applicationId,
      JSON.stringify(data),
      { expirationTtl: STAGE_TTL_SECONDS }
    );
  } catch (err) {
    return jsonResponse({ success: false, error: 'Failed to stage application', details: err.message }, 500);
  }

  return jsonResponse({ success: true, applicationId }, 200, {
    'Access-Control-Allow-Origin': '*',
  });
}

// ── Route: /webhook/orders-paid ────────────────────────────────
// Shopify calls this automatically when an order is paid.
// Verifies the request is genuinely from Shopify, pulls the staged
// application out of KV using the applicationId line-item property,
// and writes the final record to Airtable.
async function handleOrdersPaidWebhook(request, env) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get('X-Shopify-Hmac-Sha256') || '';

  const verified = await verifyShopifyHmac(rawBody, hmacHeader, env.SHOPIFY_WEBHOOK_SECRET);
  if (!verified) {
    return jsonResponse({ success: false, error: 'HMAC verification failed' }, 401);
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid order payload' }, 400);
  }

  // Find the applicationId tucked into line-item properties by the frontend
  const applicationId = extractLineItemProperty(order, 'ApplicationId');
  if (!applicationId) {
    console.error('No ApplicationId found on order', order.id);
    return jsonResponse({ success: false, error: 'No ApplicationId on order' }, 400);
  }

  let staged;
  try {
    const raw = await env.APPLICATION_STORE.get(applicationId);
    if (!raw) {
      return jsonResponse({ success: false, error: 'No staged application found (expired or already processed)' }, 404);
    }
    staged = JSON.parse(raw);
  } catch (err) {
    return jsonResponse({ success: false, error: 'Failed to read staged application', details: err.message }, 500);
  }

  // Enrich with order info now that payment is confirmed
  staged.order_id = String(order.id || '');
  staged.order_number = String(order.order_number || order.name || '');
  staged.total_amount = order.total_price ? `${order.total_price} ${order.currency || ''}`.trim() : (staged.total_amount || '');
  staged.paid_at = order.processed_at || new Date().toISOString();

  const result = await writeToAirtable(staged, env);

  if (result.ok) {
    // Clean up the staging entry now that it's safely in Airtable
    await safeDeleteKV(env, applicationId);
    return jsonResponse({ success: true, recordId: result.recordId }, 200);
  }

  // Airtable write failed — fall back to email so paid-order data isn't lost
  await sendBackupEmail(staged, result.error, env);
  return jsonResponse({ success: false, error: 'Failed to store paid application', details: result.error }, 500);
}

async function safeDeleteKV(env, key) {
  try {
    await env.APPLICATION_STORE.delete(key);
  } catch (err) {
    console.error('Failed to delete staged KV entry', key, err);
  }
}

// ── Route: /submit (legacy / admin fallback) ───────────────────
async function handleDirectSubmit(request, env) {
  let data;
  try {
    data = await request.json();
  } catch (err) {
    return jsonResponse({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const validationError = validateApplication(data);
  if (validationError) {
    return jsonResponse({ success: false, error: validationError }, 400);
  }

  const result = await writeToAirtable(data, env);

  if (result.ok) {
    return jsonResponse({ success: true, recordId: result.recordId }, 200, {
      'Access-Control-Allow-Origin': '*',
    });
  }

  const emailSent = await sendBackupEmail(data, result.error, env);
  return jsonResponse({
    success: false,
    error: 'Failed to store application. ' + (emailSent ? 'Backup email sent.' : 'Backup email also failed.'),
    details: result.error
  }, 500, {
    'Access-Control-Allow-Origin': '*',
  });
}

// ── Shared: validation ──────────────────────────────────────────
function validateApplication(data) {
  const requiredFields = [
    { key: 'email', label: 'Email address' },
    { key: 'passport_number', label: 'Passport number' },
    { key: 'surname', label: 'Surname' },
    { key: 'given_names', label: 'Given names' },
    { key: 'date_of_birth', label: 'Date of birth' },
    { key: 'passport_expiry_date', label: 'Passport expiry date' },
    { key: 'gender', label: 'Gender' },
    { key: 'passport_issuing_country', label: 'Issuing country' },
    { key: 'passport_nationality', label: 'Nationality' },
    { key: 'country_of_birth', label: 'Country of birth' },
    { key: 'street_civic', label: 'Street/Civic number' },
    { key: 'street_name', label: 'Street address' },
    { key: 'city_town', label: 'City/Town' },
    { key: 'address_country', label: 'Address country' },
  ];

  const missing = requiredFields.filter(f => {
    const val = data[f.key];
    return val === undefined || val === null || String(val).trim() === '';
  });

  if (missing.length > 0) {
    return `Missing required fields: ${missing.map(m => m.label).join(', ')}`;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(data.email)) {
    return 'Invalid email address format';
  }

  const passportRegex = /^[A-Za-z0-9]{5,20}$/;
  if (!passportRegex.test(data.passport_number)) {
    return 'Passport number must be 5-20 letters or digits';
  }

  return null;
}

// ── Shared: build Airtable fields + write ───────────────────────
function buildAirtableFields(data) {
  const genderMap = { male: 'Male', female: 'Female', other: 'Other' };

  const fields = {
    email: data.email,
    passport_number: data.passport_number,
    surname: data.surname,
    given_names: data.given_names,
    gender: genderMap[data.gender?.toLowerCase()] || data.gender,
    date_of_birth: data.date_of_birth,
    passport_expiry_date: data.passport_expiry_date,
    street_civic: data.street_civic,
    street_name: data.street_name,
    city_town: data.city_town,
    address_country: data.address_country || '',
    submitted_at: data.submitted_at || new Date().toISOString(),
    source: data.source || 'shopify-app-form',
  };

  if (data.email_confirm) fields.email_confirm = data.email_confirm;
  if (data.passport_issuing_country) fields.passport_issuing_country = data.passport_issuing_country;
  if (data.passport_issuing_country_name) fields.passport_issuing_country_name = data.passport_issuing_country_name;
  if (data.passport_nationality) fields.passport_nationality = data.passport_nationality;
  if (data.passport_nationality_name) fields.passport_nationality_name = data.passport_nationality_name;
  if (data.passport_number_confirm) fields.passport_number_confirm = data.passport_number_confirm;
  if (data.gender?.toLowerCase() === 'other' && data.gender_name) fields.gender_name = data.gender_name;
  if (data.country_of_birth) fields.country_of_birth = data.country_of_birth;
  if (data.country_of_birth_name) fields.country_of_birth_name = data.country_of_birth_name;
  if (data.passport_issue_date) fields.passport_issue_date = data.passport_issue_date;
  if (data.other_citizen) fields.other_citizen = data.other_citizen;
  if (data.citizenship_countries) fields.citizenship_countries = data.citizenship_countries;
  if (data.citizenship_countries_codes) fields.citizenship_countries_codes = data.citizenship_countries_codes;
  if (data.applied_canada) fields.applied_canada = data.applied_canada;
  if (data.uci) fields.uci = data.uci;
  if (data.uci_confirm) fields.uci_confirm = data.uci_confirm;
  if (data.apt_unit) fields.apt_unit = data.apt_unit;
  if (data.street_name_2) fields.street_name_2 = data.street_name_2;
  if (data.address_country_name) fields.address_country_name = data.address_country_name;
  if (data.district_region) fields.district_region = data.district_region;
  if (data.know_travel_date) fields.know_travel_date = data.know_travel_date;
  if (data.flight_departure_date) fields.flight_departure_date = data.flight_departure_date;
  if (data.flight_departure_time) fields.flight_departure_time = data.flight_departure_time;
  if (data.flight_departure_time_name) fields.flight_departure_time_name = data.flight_departure_time_name;
  if (data.payment_method) fields.payment_method = data.payment_method;
  if (data.billing_name) fields.billing_name = data.billing_name;
  if (data.declaration_reviewed) fields.declaration_reviewed = data.declaration_reviewed === 'Yes' || data.declaration_reviewed === true;
  if (data.declaration_truthful) fields.declaration_truthful = data.declaration_truthful === 'Yes' || data.declaration_truthful === true;
  if (data.declaration_signature_agree) fields.declaration_signature_agree = data.declaration_signature_agree === 'Yes' || data.declaration_signature_agree === true;
  if (data.signature) fields.signature = data.signature;

  return fields;
}

async function writeToAirtable(data, env) {
  const airtableFields = buildAirtableFields(data);

  try {
    const res = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Applications`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ fields: airtableFields })
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      return { ok: false, error: `Airtable HTTP ${res.status}: ${errorText}` };
    }

    const result = await res.json();
    return { ok: true, recordId: result.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendBackupEmail(data, errorMessage, env) {
  try {
    if (!env.RESEND_API_KEY || !env.BACKUP_EMAIL) return false;

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: env.BACKUP_EMAIL,
        subject: `eTA Backup — Airtable Failed (${new Date().toISOString()})`,
        text: `Airtable write failed with error:\n${errorMessage}\n\nSubmitted data:\n${JSON.stringify(data, null, 2)}`,
      })
    });
    return true;
  } catch (emailErr) {
    console.error('Email fallback failed:', emailErr);
    return false;
  }
}

// ── Shopify HMAC verification ───────────────────────────────────
async function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signature)));

  return timingSafeEqual(computed, hmacHeader);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Helpers ──────────────────────────────────────────────────────
function extractLineItemProperty(order, propertyName) {
  const lineItems = order.line_items || [];
  for (const item of lineItems) {
    const props = item.properties || [];
    const match = props.find(p => p.name === propertyName);
    if (match) return match.value;
  }
  return null;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
}