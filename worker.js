const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxjeUVzMIbR1Mg3orxMoQ8AiVWQbiP91ABsRrZmfisUYvUMXJvsR-3MukhjSJk8ZGGy4g/exec";

const SERVICE_ZIPS = new Set([
  // Salt Lake City and 84101–84129
  "84101","84102","84103","84104","84105","84106","84107","84108","84109",
  "84110","84111","84112","84113","84114","84115","84116","84117","84118",
  "84119","84120","84121","84122","84123","84124","84125","84126","84127",
  "84128","84129",
  // Other common SLC / valley 841xx
  "84132","84138","84143","84144","84145","84147","84148","84150","84152",
  "84157","84158","84165","84170","84171","84180","84184","84189","84190","84199",
  // 840xx Salt Lake valley
  "84006", // Bingham Canyon
  "84009", // South Jordan
  "84020", // Draper
  "84044", // Magna
  "84047", // Midvale
  "84065", // Riverton / Bluffdale
  "84070", // Sandy
  "84081", // West Jordan
  "84084", // West Jordan
  "84088", // West Jordan
  "84092", // Sandy
  "84093", // Sandy
  "84094", // Sandy
  "84095", // South Jordan
  "84096", // Herriman
]);

const JUNK_PHRASES = [
  "mattress",
  "box spring",
  "boxspring",
  "hazardous",
  "chemicals",
  "paint cans",
  "paint can",
  "used oil",
  "garbage",
  "trash bag",
  "trash bags",
  "construction debris",
  "medical waste",
  "hoarder",
  "just junk",
  "landfill",
];

const JUNK_WORDS = ["food", "dirt", "rocks", "animal"];

const FALSE_POS = /dirt\s*bikes?|food\s*processors?|food\s*savers?|foodsaver|rocking\s*chairs?/g;

function zipOf(raw) {
  return String(raw || "").replace(/\D/g, "").slice(0, 5);
}

function hasJunk(title, description) {
  let text = ((title || "") + " " + (description || "")).toLowerCase();
  text = text.replace(FALSE_POS, " ");
  for (const p of JUNK_PHRASES) {
    if (text.includes(p)) return p;
  }
  for (const w of JUNK_WORDS) {
    if (new RegExp("\\b" + w + "\\b").test(text)) return w;
  }
  return null;
}

function httpPhotoUrls(data) {
  const raw = data && data.photoUrls;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((u) => String(u || "").trim())
    .filter((u) => /^https?:\/\//i.test(u));
}

function photoCountOf(data) {
  const n = Number(data && data.photoCount) || 0;
  return Math.max(n, httpPhotoUrls(data).length);
}

function prescreen(data) {
  const photoCount = photoCountOf(data);
  if (photoCount < 1) {
    return { ok: false, reason: "photos required" };
  }
  const zip = zipOf(data.zip);
  if (zip.length !== 5) {
    return { ok: false, reason: "a 5-digit zip is required" };
  }
  if (!SERVICE_ZIPS.has(zip)) {
    return { ok: false, reason: "outside service area" };
  }
  const junk = hasJunk(data.title, data.description);
  if (junk) {
    return { ok: false, reason: "not a fit for free value pickup" };
  }
  const desc = String(data.description || "").trim();
  if (desc.length < 15) {
    return { ok: false, reason: "please add more detail about the item" };
  }
  const title = String(data.title || "").trim();
  if (!title) {
    return { ok: false, reason: "what is it is required" };
  }
  const phone = String(data.phone || "").trim();
  if (!phone) {
    return { ok: false, reason: "phone is required" };
  }
  const name = String(data.name || "").trim();
  if (!name) {
    return { ok: false, reason: "name is required" };
  }
  // Furniture/appliance "for parts" is lenient: only junk keywords (mattress/hazard/trash) auto-decline.
  return { ok: true };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders()),
  });
}

async function verifyTurnstile(request, env, data) {
  if (!env.TURNSTILE_SECRET_KEY) {
    return json({ ok: false, status: "error", reason: "bot check not configured" }, 503);
  }
  const token = String((data && (data.turnstileToken || data["cf-turnstile-response"])) || "").trim();
  if (!token) {
    return json({ ok: false, status: "declined", reason: "bot check required" }, 401);
  }
  try {
    const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined,
      }),
    });
    const verify = await verifyRes.json();
    if (!verify || !verify.success) {
      return json({ ok: false, status: "declined", reason: "bot check failed" }, 401);
    }
  } catch (e) {
    return json({ ok: false, status: "declined", reason: "bot check failed" }, 401);
  }
  return null;
}

// --- lexical search (client may mirror) ---
const SYN_GROUPS = [
  ["mower", "lawnmower", "lawn mower", "riding mower", "tractor", "deere"],
  ["scooter", "moped", "ebike", "e-bike", "electric bike", "mobility", "razor", "wheelchair", "jazzy"],
  ["washer", "dryer", "laundry", "washing machine"],
  ["ac", "air conditioner", "aircon", "cooling", "hvac", "swamp cooler", "evaporative"],
  ["generator", "inverter", "genset"],
  ["tv", "television", "monitor", "display"],
  ["printer", "scanner", "copier"],
  ["vacuum", "mop", "tineco", "bissell", "shark", "floor cleaner"],
  ["snowblower", "snow blower", "snow thrower"],
  ["pressure washer", "power washer"],
  ["trailer", "camper", "rv", "fifth wheel"],
  ["atv", "quad", "four wheeler", "4wheeler"],
  ["motorcycle", "dirt bike", "moto"],
  ["microwave", "oven"],
  ["chair", "recliner", "massage chair"],
  ["computer", "pc", "imac", "desktop", "laptop"],
];

function tokenize(s) {
  const lower = String(s || "").toLowerCase();
  const spaced = lower.replace(/[^a-z0-9]+/g, " ").trim();
  const a = spaced ? spaced.split(/\s+/).filter(Boolean) : [];
  const collapsed = lower.replace(/-/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const b = collapsed ? collapsed.split(/\s+/).filter(Boolean) : [];
  const out = [];
  const seen = Object.create(null);
  for (const t of a.concat(b)) {
    if (!seen[t]) {
      seen[t] = 1;
      out.push(t);
    }
  }
  return out;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  const n = a.length, m = b.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    dp[i] = new Array(m + 1);
    dp[i][0] = i;
  }
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) {
        dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
      }
    }
  }
  return dp[n][m];
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function tokenMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3) {
    if (b.indexOf(a) === 0 || a.indexOf(b) === 0) return true;
  }
  if (a.length >= 4 && b.length >= 4 && a.charCodeAt(0) === b.charCodeAt(0) && levenshtein(a, b) <= 1) {
    if (commonPrefixLen(a, b) >= 2) return true;
  }
  return false;
}

function anyTokenMatch(token, bagList) {
  for (let i = 0; i < bagList.length; i++) {
    if (tokenMatch(token, bagList[i])) return true;
  }
  return false;
}

function expandTokens(tokens, rawText) {
  const set = Object.create(null);
  for (const t of tokens) set[t] = 1;
  const hay = " " + String(rawText || tokens.join(" ")).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  for (let g = 0; g < SYN_GROUPS.length; g++) {
    const group = SYN_GROUPS[g];
    let hit = false;
    for (let i = 0; i < group.length; i++) {
      const phrase = group[i];
      if (phrase.indexOf(" ") !== -1) {
        if (hay.indexOf(" " + phrase + " ") !== -1) {
          hit = true;
          break;
        }
      } else if (set[phrase]) {
        hit = true;
        break;
      }
    }
    if (hit) {
      for (let i = 0; i < group.length; i++) {
        const parts = group[i].replace(/-/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/);
        const GENERIC = { electric:1, machine:1, machines:1, powered:1, start:1 };
        for (let j = 0; j < parts.length; j++) {
          if (parts[j] && !GENERIC[parts[j]]) set[parts[j]] = 1;
        }
        const collapsed = group[i].replace(/-/g, "").replace(/[^a-z0-9]+/g, "");
        if (collapsed) set[collapsed] = 1;
      }
    }
  }
  return Object.keys(set);
}

function aliasBlob(title) {
  const tokens = tokenize(title);
  return expandTokens(tokens, title).join(" ");
}

const STOP = { to:1, the:1, a:1, an:1, of:1, for:1, and:1, or:1, in:1, on:1, at:1, is:1, it:1, something:1, some:1, any:1, please:1, with:1, this:1, that:1, from:1 };

function lexicalScore(q, title, category) {
  const qTokens = tokenize(q).filter((t) => t.length > 1 && !STOP[t]);
  if (!qTokens.length) return 0;
  const titleTokens = tokenize(title);
  const titleExp = expandTokens(titleTokens, title);
  const titleExpSet = Object.create(null);
  for (let i = 0; i < titleExp.length; i++) titleExpSet[titleExp[i]] = 1;
  let matched = 0;
  let direct = 0;
  for (let i = 0; i < qTokens.length; i++) {
    const qt = qTokens[i];
    let isDirect = false;
    for (let j = 0; j < titleTokens.length; j++) {
      if (tokenMatch(qt, titleTokens[j])) {
        isDirect = true;
        break;
      }
    }
    let ok = isDirect;
    if (!ok) {
      const alts = expandTokens([qt], qt);
      for (let j = 0; j < alts.length; j++) {
        if (titleExpSet[alts[j]]) {
          ok = true;
          break;
        }
      }
    }
    if (ok) matched++;
    if (isDirect) direct++;
  }
  if (!matched) return 0;
  let score = (direct * 1 + (matched - direct) * 0.72) / qTokens.length;
  const catTok = tokenize(category);
  for (let i = 0; i < qTokens.length; i++) {
    if (anyTokenMatch(qTokens[i], catTok)) {
      score = Math.min(1, score + 0.12);
      break;
    }
  }
  return score;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

let itemVecCache = null;
let itemVecSig = "";

async function loadInventory(env, request) {
  const u = new URL("/inventory.json", request.url);
  const r = await env.ASSETS.fetch(new Request(u.toString(), { method: "GET" }));
  if (!r.ok) throw new Error("inventory");
  const data = await r.json();
  return (data.items || []).filter((it) => it.status !== "sold");
}

async function embedTexts(ai, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 20) {
    const slice = texts.slice(i, i + 20);
    const res = await ai.run("@cf/baai/bge-small-en-v1.5", { text: slice });
    const data = (res && res.data) || res;
    for (let j = 0; j < slice.length; j++) out.push(data[j]);
  }
  return out;
}

async function ensureItemVecs(ai, items) {
  const sig = items.map((it) => String(it.id) + ":" + String(it.title || "")).join("|");
  if (itemVecCache && itemVecSig === sig) return itemVecCache;
  const texts = items.map((it) => {
    const title = String(it.title || "");
    const cat = String(it.category || "");
    return title + " " + cat + " " + aliasBlob(title);
  });
  const vecs = await embedTexts(ai, texts);
  const map = Object.create(null);
  for (let i = 0; i < items.length; i++) map[String(items[i].id)] = vecs[i];
  itemVecCache = map;
  itemVecSig = sig;
  return map;
}

async function handleSearch(request, env, url) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  let q = url.searchParams.get("q");
  let category = url.searchParams.get("category");
  if (q == null) q = "";
  if (category == null) category = "";
  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (body) {
        if (!url.searchParams.has("q") && body.q != null) q = body.q;
        if (!url.searchParams.has("category") && body.category != null) category = body.category;
      }
    } catch (e) {}
  }
  q = String(q || "").trim();
  category = String(category || "").trim();

  let items;
  try {
    items = await loadInventory(env, request);
  } catch (e) {
    return json({ q: q, mode: "lexical", items: [] }, 200);
  }
  if (category) {
    items = items.filter((it) => String(it.category || "") === category);
  }

  if (!q) {
    return json({
      q: q,
      mode: "lexical",
      items: items.map((it) => ({ id: String(it.id), score: 1 })),
    });
  }

  const lexicalRows = items.map((it) => ({
    id: String(it.id),
    lex: lexicalScore(q, it.title, it.category),
    sem: 0,
  }));

  let mode = "lexical";
  if (env.AI) {
    try {
      const qRes = await env.AI.run("@cf/baai/bge-small-en-v1.5", { text: [q] });
      const qVec = ((qRes && qRes.data) || qRes)[0];
      if (qVec && qVec.length) {
        const vecs = await ensureItemVecs(env.AI, items);
        for (let i = 0; i < lexicalRows.length; i++) {
          const v = vecs[lexicalRows[i].id];
          const c = cosine(qVec, v);
          // 0.28 was too loose and ranked almost everything; require a real match.
          lexicalRows[i].sem = c >= 0.42 ? c : 0;
        }
        mode = "hybrid";
      }
    } catch (e) {
      mode = "lexical";
    }
  }

  const outItems = [];
  for (let i = 0; i < lexicalRows.length; i++) {
    const row = lexicalRows[i];
    let score = Math.max(row.sem, row.lex);
    // Drop weak embedding-only hits with no word/synonym overlap.
    if (row.lex <= 0 && row.sem < 0.55) score = 0;
    if (score >= 0.35) outItems.push({ id: row.id, score: Math.round(score * 1000) / 1000 });
  }
  outItems.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return json({ q: q, mode: mode, items: outItems });
}


const VOICE_MISS = { speak: "Say that again?", fields: {}, ready: false };
const VOICE_FIELD_KEYS = ["title", "description", "condition", "category", "city", "zip", "name", "phone", "email", "access"];
const VOICE_CONDITIONS = ["working", "needs minor repair", "for parts", "not sure"];
const VOICE_CATEGORIES = ["furniture", "appliance", "electronics", "tools", "sporting/outdoor", "auto", "other"];

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function pickVoiceFields(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const k of VOICE_FIELD_KEYS) {
    if (obj[k] === undefined || obj[k] === null || obj[k] === "") continue;
    if (k === "condition") {
      const hit = VOICE_CONDITIONS.find((c) => c.toLowerCase() === String(obj[k]).trim().toLowerCase());
      if (hit) out[k] = hit;
      continue;
    }
    if (k === "category") {
      const raw = String(obj[k]).trim().toLowerCase().replace(/\s+/g, " ");
      const compact = raw.replace(/\s*\/\s*/g, "/");
      const hit = VOICE_CATEGORIES.find((c) => c === compact || c === raw);
      if (hit) out[k] = hit;
      continue;
    }
    if (k === "zip") {
      const z = zipOf(obj[k]);
      if (z.length === 5) out[k] = z;
      continue;
    }
    out[k] = String(obj[k]).trim();
  }
  return out;
}

function voiceReady(fields) {
  const title = String(fields.title || "").trim();
  const desc = String(fields.description || "").trim();
  const z = zipOf(fields.zip);
  const name = String(fields.name || "").trim();
  const phone = String(fields.phone || "").trim();
  return !!(title && desc.length >= 15 && z.length === 5 && name && phone);
}

function dropInventedContact(extracted, incoming, transcript) {
  const tDigits = String(transcript || "").replace(/\D/g, "");
  const out = Object.assign({}, extracted);
  if (out.zip && !zipOf(incoming.zip)) {
    const z = zipOf(out.zip);
    if (!tDigits.includes(z)) delete out.zip;
  }
  if (out.phone && !String(incoming.phone || "").trim()) {
    const p = String(out.phone).replace(/\D/g, "");
    if (p.length < 7 || !tDigits.includes(p)) delete out.phone;
  }
  return out;
}

async function handleVoice(request, env) {
  const headers = Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders());
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders() });
  }
  try {
    const body = await request.json();
    const transcript = String((body && body.transcript) || "").trim();
    const fields = (body && body.fields && typeof body.fields === "object") ? body.fields : {};
    const history = Array.isArray(body && body.history) ? body.history.slice(-6) : [];

    const system =
      "You help people request a FREE pickup from Still Has Value in the Salt Lake valley. We pick up items that still have resale value. Not junk hauling. Extract what they said into JSON. Never invent a phone number or zip. Only set phone or zip if they clearly said the digits. condition must be one of: working, needs minor repair, for parts, not sure. category must be one of: furniture, appliance, electronics, tools, sporting/outdoor, auto, other.\nKnown fields so far: " +
      JSON.stringify(pickVoiceFields(fields)) +
      '\nReply ONLY JSON: {"fields":{...only keys you are confident about...},"speak":"one short spoken question or recap","ready":false}\nSet ready true only when title, description (at least 15 characters), zip, name, and phone are present (in incoming fields or newly extracted). When ready, speak a one-sentence recap and ask them to confirm they want to send it.\nIf they said yes/submit/send it and ready, {"fields":{},"speak":"Sending your pickup request.","ready":true,"submit":true}\nIf the item is junk, a mattress, box spring, hazardous, chemicals, trash, or similar, speak that it is not a fit for free value pickup, set ready false, and do not set submit.';

    const messages = [{ role: "system", content: system }];
    for (const h of history) {
      if (!h) continue;
      const role = (h.role === "assistant" || h.role === "agent") ? "assistant" : "user";
      const text = String(h.text || h.content || "").trim();
      if (text) messages.push({ role, content: text });
    }
    messages.push({ role: "user", content: transcript || "(no speech)" });

    const result = await env.AI.run("@cf/meta/llama-3.2-3b-instruct", {
      messages,
      max_tokens: 400,
      temperature: 0.2,
    });
    const raw = typeof result === "string" ? result : (result && (result.response || result.result)) || "";
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") {
      return new Response(JSON.stringify(VOICE_MISS), { status: 200, headers });
    }
    const extracted = dropInventedContact(pickVoiceFields(parsed.fields), fields, transcript);
    const merged = Object.assign({}, pickVoiceFields(fields), extracted);
    const junk = hasJunk(merged.title, merged.description);
    const ready = !junk && voiceReady(merged);
    const out = {
      fields: extracted,
      speak: String(parsed.speak || "Got it. What else?"),
      ready,
    };
    if (junk) {
      out.speak = "This doesn’t look like a fit for a free value pickup. We don’t haul junk, mattresses, or hazardous stuff.";
      out.ready = false;
    } else if (parsed.submit && ready) {
      out.submit = true;
    }
    return new Response(JSON.stringify(out), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify(VOICE_MISS), { status: 200, headers });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/voice") {
      return handleVoice(request, env);
    }
    if (url.pathname === "/api/search") {
      return handleSearch(request, env, url);
    }
    if (url.pathname === "/api/pickup") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (request.method !== "POST") {
        return json({ ok: false, status: "error", reason: "method not allowed" }, 405);
      }
      let data;
      try {
        data = await request.json();
      } catch (e) {
        return json({ ok: false, status: "declined", reason: "invalid json" });
      }
      data = data || {};
      const bot = await verifyTurnstile(request, env, data);
      if (bot) return bot;
      const check = prescreen(data);
      if (!check.ok) {
        return json({ ok: false, status: "declined", reason: check.reason });
      }
      const title = String(data.title || "").trim();
      const zip = zipOf(data.zip);
      const urls = httpPhotoUrls(data);
      const payload = {
        name: String(data.name || "").trim(),
        phone: String(data.phone || "").trim(),
        email: String(data.email || "").trim(),
        city: String(data.city || "").trim(),
        zip,
        title,
        description: String(data.description || "").trim(),
        condition: String(data.condition || "").trim(),
        category: String(data.category || "").trim(),
        access: String(data.access || "").trim(),
        photoCount: Math.max(Number(data.photoCount) || 0, urls.length),
        source: String(data.source || "").trim(),
        _subject: data._subject || ("SHV pickup request: " + title + " (" + zip + ")"),
      };
      payload.kind = "pickup";
      if (urls.length) payload.photoUrls = urls;
      try {
        const r = await fetch(SCRIPT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(payload),
          redirect: "follow",
        });
        const text = await r.text();
        let parsed = {};
        try { parsed = JSON.parse(text); } catch (e) {}
        if (r.ok && parsed && parsed.ok) {
          return json({ ok: true, status: "queued", notify: parsed.notify || "email" });
        }
        return json({ ok: false, status: "error", reason: "could not save pickup" }, 502);
      } catch (e) {
        return json({ ok: false, status: "error", reason: "could not save pickup" }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
