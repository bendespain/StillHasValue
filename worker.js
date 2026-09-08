const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxjeUVzMIbR1Mg3orxMoQ8AiVWQbiP91ABsRrZmfisUYvUMXJvsR-3MukhjSJk8ZGGy4g/exec";

const FE_VOICE_MINT_URL = "https://fe-voice-mint.ben-e22.workers.dev";

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
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-SHV-Pickup, X-SHV-Voice-Test",
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

const AI_SOURCES = new Set(["grok", "gemini", "claude", "chatgpt"]);
const AI_CLIENT_TOKEN = "stillhasvalue-pickup";
const AI_RATE_WINDOW_MS = 10 * 60 * 1000;
const AI_RATE_MAX = 8;
const aiRateBuckets = new Map();

function isTrustedAiSource(source) {
  return AI_SOURCES.has(String(source || "").trim().toLowerCase());
}

function aiClientTokenOf(data, request) {
  const fromBody = data && (data.clientToken || data.aiClientToken);
  const fromHeader = request && request.headers.get("X-SHV-Pickup");
  return String(fromBody || fromHeader || "").trim();
}

function aiClientOk(data, request) {
  return aiClientTokenOf(data, request) === AI_CLIENT_TOKEN;
}

function clientIp(request) {
  return (
    (request.headers.get("CF-Connecting-IP") || "").trim() ||
    (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim() ||
    "unknown"
  );
}

function aiRateLimited(ip) {
  const now = Date.now();
  let hits = aiRateBuckets.get(ip) || [];
  hits = hits.filter((t) => now - t < AI_RATE_WINDOW_MS);
  if (hits.length >= AI_RATE_MAX) {
    aiRateBuckets.set(ip, hits);
    return true;
  }
  hits.push(now);
  aiRateBuckets.set(ip, hits);
  if (aiRateBuckets.size > 2000) {
    for (const [k, v] of aiRateBuckets) {
      const nv = v.filter((t) => now - t < AI_RATE_WINDOW_MS);
      if (!nv.length) aiRateBuckets.delete(k);
      else aiRateBuckets.set(k, nv);
    }
  }
  return false;
}

function pickupSchemaInfo() {
  return {
    ok: true,
    name: "Still Has Value customer pickup request",
    description: "Used goods pickup in the Salt Lake valley. Not junk, mattresses, or hazardous waste.",
    endpoint: "https://stillhasvalue.com/api/pickup",
    method: "POST",
    schema: "https://stillhasvalue.com/pickup.json",
    llms: "https://stillhasvalue.com/llms.txt",
    humanForm: "https://stillhasvalue.com/pickup",
    notifyEmail: "request@stillhasvalue.com",
    clientToken: AI_CLIENT_TOKEN,
    aiSources: ["grok", "gemini", "claude", "chatgpt"],
    instruction: "If the human wants a pickup, POST for them. Do not invent phone or zip. Do not send them to the form unless they prefer it.",
  };
}

// --- lexical search (client may mirror) ---
const SYN_GROUPS = [
  ["mower", "lawnmower", "lawn mower", "riding mower", "tractor", "deere", "cut grass"],
  ["mobile", "mobility", "vehicle", "vehicles", "rideable", "rideables", "ride", "powersports", "scooter", "moped", "ebike", "e-bike", "electric bike", "razor", "wheelchair", "jazzy", "atv", "quad", "four wheeler", "4wheeler", "motorcycle", "dirt bike", "moto", "go kart", "go-kart", "gokart", "go cart", "go-cart", "gocart", "golf cart", "cart", "snowmobile", "tricycle", "hover"],
  ["washer", "dryer", "laundry", "washing machine"],
  ["ac", "air conditioner", "aircon", "cooling", "hvac", "swamp cooler", "evaporative"],
  ["generator", "inverter", "genset"],
  ["tv", "television", "monitor", "display"],
  ["printer", "scanner", "copier"],
  ["vacuum", "mop", "tineco", "bissell", "shark", "floor cleaner"],
  ["snowblower", "snow blower", "snow thrower"],
  ["pressure washer", "power washer"],
  ["trailer", "camper", "rv", "fifth wheel"],
  ["microwave", "oven"],
  ["chair", "recliner", "massage chair"],
  ["computer", "pc", "imac", "desktop", "laptop"],
];

const EXPAND_GENERIC = { electric:1, machine:1, machines:1, powered:1, start:1, four:1, go:1, lawn:1, golf:1, dirt:1, bike:1 };

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

function synGroupMatches(group, tokens, rawText) {
  const set = Object.create(null);
  for (let i = 0; i < tokens.length; i++) set[tokens[i]] = 1;
  const hay = " " + String(rawText || tokens.join(" ")).toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
  for (let i = 0; i < group.length; i++) {
    const phrase = group[i];
    if (phrase.indexOf(" ") !== -1) {
      if (hay.indexOf(" " + phrase + " ") !== -1) return true;
    } else if (set[phrase] || (phrase.length >= 4 && set[phrase + "s"]) || (phrase.length >= 5 && phrase.charAt(phrase.length - 1) === "s" && set[phrase.slice(0, -1)])) {
      return true;
    }
  }
  return false;
}

function expandTokens(tokens, rawText) {
  const set = Object.create(null);
  for (const t of tokens) set[t] = 1;
  for (let g = 0; g < SYN_GROUPS.length; g++) {
    const group = SYN_GROUPS[g];
    if (synGroupMatches(group, tokens, rawText)) {
      for (let i = 0; i < group.length; i++) {
        const parts = group[i].replace(/-/g, " ").replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/);
        for (let j = 0; j < parts.length; j++) {
          if (parts[j] && !EXPAND_GENERIC[parts[j]]) set[parts[j]] = 1;
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
  const blob = (String(title || "") + " " + String(category || "")).trim();
  const titleTokens = tokenize(blob);
  const titleExp = expandTokens(titleTokens, blob);
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
  let score = 0;
  if (matched) {
    score = (direct * 1 + (matched - direct) * 0.72) / qTokens.length;
    const catTok = tokenize(category);
    for (let i = 0; i < qTokens.length; i++) {
      if (anyTokenMatch(qTokens[i], catTok)) {
        score = Math.min(1, score + 0.12);
        break;
      }
    }
  }
  // Phrase synonym: "cut grass" shares the mower group even if no single token matched.
  for (let g = 0; g < SYN_GROUPS.length; g++) {
    if (synGroupMatches(SYN_GROUPS[g], qTokens, q) && synGroupMatches(SYN_GROUPS[g], titleTokens, blob)) {
      score = Math.max(score, 0.72);
      break;
    }
  }
  return score;
}


function searchExplain(q) {
  const qDisplay = String(q || "").trim();
  if (!qDisplay) return "";
  const qTokens = tokenize(qDisplay).filter((t) => t.length > 1 && !STOP[t]);
  if (!qTokens.length) return "";
  const qSet = Object.create(null);
  for (let i = 0; i < qTokens.length; i++) qSet[qTokens[i]] = 1;
  const ql = qDisplay.toLowerCase();
  const hitGroups = [];
  for (let g = 0; g < SYN_GROUPS.length; g++) {
    if (synGroupMatches(SYN_GROUPS[g], qTokens, qDisplay)) hitGroups.push(SYN_GROUPS[g]);
  }
  if (hitGroups.length) {
    const seen = Object.create(null);
    const examples = [];
    for (let h = 0; h < hitGroups.length; h++) {
      const group = hitGroups[h];
      for (let i = 0; i < group.length; i++) {
        const phrase = group[i];
        if (!phrase || phrase === ql || qSet[phrase] || seen[phrase] || EXPAND_GENERIC[phrase]) continue;
        if (phrase.indexOf(ql) === 0 || ql.indexOf(phrase) === 0) continue;
        seen[phrase] = 1;
        examples.push(phrase);
        if (examples.length >= 4) break;
      }
      if (examples.length >= 4) break;
    }
    let isRide = false;
    for (let h = 0; h < hitGroups.length; h++) {
      const g = hitGroups[h];
      if (g.indexOf("moped") !== -1 && g.indexOf("scooter") !== -1) { isRide = true; break; }
    }
    if (isRide) {
      return "Showing rideables and small vehicles related to “" + qDisplay + "” — mopeds, scooters, carts, and similar — even when the title doesn’t say “" + qDisplay + "”.";
    }
    const extra = examples.length ? " like " + examples.slice(0, 3).join(", ") : "";
    return "Including related listings" + extra + " even if the title doesn’t say “" + qDisplay + "”.";
  }
  if (qTokens.length <= 1) {
    return "Only items that are actually “" + qDisplay + "” — the title or category needs to match that word, not a loose guess.";
  }
  return "Matching “" + qDisplay + "” by the words you typed and close meaning, not the whole catalog.";
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
    return title + " " + cat + " " + aliasBlob(title + " " + cat);
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
    return json({ q: q, mode: "lexical", items: [], explain: "" }, 200);
  }
  if (category) {
    items = items.filter((it) => String(it.category || "") === category);
  }

  if (!q) {
    return json({
      q: q,
      mode: "lexical",
      items: items.map((it) => ({ id: String(it.id), score: 1 })),
      explain: "",
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

  const qTokens = tokenize(q).filter((t) => t.length > 1 && !STOP[t]);
  const nTok = qTokens.length;
  const outItems = [];
  for (let i = 0; i < lexicalRows.length; i++) {
    const row = lexicalRows[i];
    const lex = row.lex;
    const sem = row.sem;
    // Prefer a real word match; a weak embed cannot outrank one or sneak in alone.
    const score = Math.max(lex, 0.4 * lex + 0.6 * sem);
    let keep;
    if (nTok <= 1) {
      // Single noun like "lamp": require lexical overlap or a very high embedding.
      keep = lex > 0 || sem >= 0.78;
    } else {
      // Phrase / meaning search ("something to cut grass"): embedding-only if strong.
      keep = lex > 0 || sem >= 0.68;
    }
    // Include floor: drop mid scores unless the word hit is strong.
    if (keep && lex < 0.5 && score < 0.60) {
      const embedOnlyOk = lex <= 0 && ((nTok <= 1 && sem >= 0.78) || (nTok > 1 && sem >= 0.68));
      if (!embedOnlyOk) keep = false;
    }
    if (keep && score > 0) outItems.push({ id: row.id, score: Math.round(score * 1000) / 1000 });
  }
  outItems.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return json({ q: q, mode: mode, items: outItems, explain: searchExplain(q) });
}


const VOICE_MISS = { speak: "Say that again?", fields: {}, ready: false, mode: "lexical" };
const VOICE_FIELD_KEYS = ["title", "description", "condition", "category", "city", "zip", "name", "phone", "email", "access"];
const VOICE_CONDITIONS = ["working", "needs minor repair", "for parts", "not sure"];
const VOICE_CATEGORIES = ["furniture", "appliance", "electronics", "tools", "sporting/outdoor", "auto", "other"];
const VOICE_MODELS = [
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/qwen/qwen1.5-0.5b-chat",
];

function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  // Prefer balanced first object; fall back to last closing brace.
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) end = s.lastIndexOf("}");
  if (end <= start) return null;
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
    if (k === "phone") {
      let nd = String(obj[k]).replace(/\D/g, "");
      if (nd.length === 11 && nd.charAt(0) === "1") nd = nd.slice(1);
      if (nd.length >= 7) out[k] = nd;
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


const SPOKEN_DIGIT = {
  zero: "0", oh: "0", o: "0",
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
  niner: "9",
};

/** Turn spoken number words / digits in text into a digit string (for phone/zip checks). */
function spokenDigits(text) {
  const raw = String(text || "").toLowerCase();
  const out = [];
  const tokens = raw
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^\d+$/.test(t)) {
      out.push(...t.split(""));
      i++;
      continue;
    }
    // "double five" / "triple two"
    if ((t === "double" || t === "triple") && i + 1 < tokens.length) {
      const next = tokens[i + 1];
      const d = SPOKEN_DIGIT[next] || (/^\d$/.test(next) ? next : null);
      if (d) {
        const n = t === "triple" ? 3 : 2;
        for (let k = 0; k < n; k++) out.push(d);
        i += 2;
        continue;
      }
    }
    if (SPOKEN_DIGIT[t]) {
      out.push(SPOKEN_DIGIT[t]);
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
}

function transcriptDigitStream(transcript) {
  const raw = String(transcript || "");
  const fromDigits = raw.replace(/\D/g, "");
  const fromSpoken = spokenDigits(raw);
  // Prefer union: spoken may fill gaps when ASR wrote words; digits when ASR wrote numerals.
  if (!fromSpoken) return fromDigits;
  if (!fromDigits) return fromSpoken;
  if (fromDigits.includes(fromSpoken) || fromSpoken.includes(fromDigits)) {
    return fromSpoken.length >= fromDigits.length ? fromSpoken : fromDigits;
  }
  return fromDigits + fromSpoken;
}

function dropInventedContact(extracted, incoming, transcript) {
  const tDigits = transcriptDigitStream(transcript);
  const out = Object.assign({}, extracted);
  if (out.zip && !zipOf(incoming.zip)) {
    const z = zipOf(out.zip);
    if (z && !tDigits.includes(z)) delete out.zip;
  }
  if (out.phone && !String(incoming.phone || "").trim()) {
    let p = String(out.phone).replace(/\D/g, "");
    if (p.length === 11 && p.charAt(0) === "1") p = p.slice(1);
    // Keep if transcript has the digits (typed or spoken-as-words), or last 7 match.
    const ok =
      p.length >= 7 &&
      (tDigits.includes(p) ||
        tDigits.includes(p.slice(-10)) ||
        tDigits.includes(p.slice(-7)) ||
        (tDigits.length >= 7 && p.endsWith(tDigits.slice(-7))));
    if (!ok) delete out.phone;
  }
  return out;
}

function fieldsUseful(obj) {
  if (!obj || typeof obj !== "object") return false;
  for (const k of VOICE_FIELD_KEYS) {
    if (obj[k] != null && String(obj[k]).trim()) return true;
  }
  return false;
}

function nextMissingSpeak(merged) {
  const title = String(merged.title || "").trim();
  const desc = String(merged.description || "").trim();
  const z = zipOf(merged.zip);
  const name = String(merged.name || "").trim();
  const phone = String(merged.phone || "").trim();
  if (!title) return "What is the item?";
  if (desc.length < 15) return "Tell me a bit more about the condition or details.";
  if (z.length !== 5) return "What is your five-digit zip code?";
  if (!name) return "What is your name?";
  if (!phone) return "What phone number should we use? You can say the digits out loud.";
  return "I have what I need. Add a photo with Add photos if you haven't, then say send it.";
}

function lexicalPickupExtract(transcript, fields) {
  const incoming = pickVoiceFields(fields);
  const t = String(transcript || "").trim();
  const lower = t.toLowerCase();
  const out = {};
  if (!t) {
    return { fields: {}, speak: nextMissingSpeak(incoming), ready: voiceReady(incoming) };
  }

  const zipMatch = t.match(/\b(\d{5})\b/);
  if (zipMatch) out.zip = zipMatch[1];

  const phoneMatch = t.match(/(?:\+?1[\s\-.]?)?(?:\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}|\d{7,10})\b/);
  if (phoneMatch) {
    let nd = phoneMatch[0].replace(/\D/g, "");
    if (nd.length === 11 && nd.charAt(0) === "1") nd = nd.slice(1);
    if (nd.length >= 7) out.phone = nd;
  } else {
    const spoken = spokenDigits(t);
    let nd = spoken;
    if (nd.length === 11 && nd.charAt(0) === "1") nd = nd.slice(1);
    // Prefer 10-digit US phone when a longer spoken stream is present
    if (nd.length > 10) {
      const m10 = nd.match(/(\d{10})/);
      if (m10) nd = m10[1];
    }
    if (nd.length >= 7 && nd.length <= 10) out.phone = nd;
  }

  const nameMatch = t.match(/\b(?:my name is|name is|i am|i'm)\s+([A-Za-z][A-Za-z .'-]{1,60}?)(?=[,.]|\s+(?:and|phone|zip|at|in|my|the|it)\b|$)/i);
  if (nameMatch) out.name = nameMatch[1].trim().replace(/\s+/g, " ").slice(0, 80);

  if (/\bfor parts\b/i.test(lower)) out.condition = "for parts";
  else if (/\bneeds?\s+minor\s+repair\b|\bminor\s+repair\b/i.test(lower)) out.condition = "needs minor repair";
  else if (/\bnot sure\b/i.test(lower)) out.condition = "not sure";
  else if (/\bworking\b|\bworks\b|\bheats?\b|\bruns?\b/i.test(lower)) out.condition = "working";

  const catRules = [
    ["appliance", /\b(microwave|fridge|refrigerator|freezer|washer|dryer|oven|stove|dishwasher|appliance)\b/i],
    ["furniture", /\b(sofa|couch|dresser|table|chair|desk|bed|furniture|bookshelf|cabinet)\b/i],
    ["electronics", /\b(tv|television|laptop|computer|monitor|speaker|electronics|stereo|console)\b/i],
    ["tools", /\b(drill|saw|wrench|tools?|compressor)\b/i],
    ["sporting/outdoor", /\b(bike|bicycle|treadmill|kayak|tent|camping|sporting|outdoor)\b/i],
    ["auto", /\b(car|truck|tire|auto|vehicle|bumper)\b/i],
  ];
  for (const [cat, re] of catRules) {
    if (re.test(t)) { out.category = cat; break; }
  }

  if (!incoming.description || String(incoming.description).trim().length < 15) {
    if (t.length >= 15) out.description = t.slice(0, 2000);
  }

  if (!incoming.title) {
    let title = "";
    const item = t.match(/\b(?:a|an|the)\s+((?:working|used|old|new)\s+)?([a-z][a-z0-9 \-]{2,40}?)(?=\s+(?:in|at|for|with|that|which|zip|my|phone|,|\.))/i);
    if (item) title = ((item[1] || "") + item[2]).trim();
    if (!title) {
      const words = t.replace(/[^\w\s'-]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 8);
      title = words.join(" ");
    }
    if (title) out.title = title.slice(0, 120);
  }

  const extracted = dropInventedContact(pickVoiceFields(out), incoming, t);
  const merged = Object.assign({}, incoming, extracted);
  const junk = hasJunk(merged.title, merged.description);
  if (junk) {
    return {
      fields: {},
      speak: "This doesn’t look like a fit for a free value pickup. We don’t haul junk, mattresses, or hazardous stuff.",
      ready: false,
    };
  }
  const ready = voiceReady(merged);
  const confirm = /\b(yes|yeah|yep|send it|submit|request pickup|go ahead|please send)\b/i.test(lower);
  const outLex = {
    fields: extracted,
    speak: ready
      ? (confirm
          ? "Sending your pickup request."
          : ("Got it: " + merged.title + ". Add a photo with Add photos if needed, then say send it."))
      : nextMissingSpeak(merged),
    ready,
  };
  if (ready && confirm) outLex.submit = true;
  return outLex;
}

async function runVoiceModels(env, messages) {
  if (!env || !env.AI || typeof env.AI.run !== "function") return "";
  for (const model of VOICE_MODELS) {
    try {
      const result = await env.AI.run(model, {
        messages,
        max_tokens: 400,
        temperature: 0.2,
      });
      const text = typeof result === "string"
        ? result
        : (result && (result.response || result.result || result.text)) || "";
      const raw = String(text || "").trim();
      if (raw) return raw;
    } catch (e) {
      // try next model; do not log transcript or PII
    }
  }
  return "";
}

/** Fail-closed AI pressure-test: used item plausibly worth $100+ (US/SLC thrift). */
async function assessItemWorth100Plus(env, itemText) {
  const text = String(itemText || "").trim();
  if (text.length < 12) {
    return { plausible: false, reason: "Item description too short or vague.", failed: false };
  }
  const junk = hasJunk(text, "");
  if (junk) {
    return { plausible: false, reason: "Not a fit for free value pickup (" + junk + ").", failed: false };
  }
  const system =
    "You decide if a used consumer item described is *plausibly* worth at least $100 on the used market " +
    "(US / Salt Lake City thrift and resale style). Be skeptical of vague claims like \"stuff\", \"furniture\", " +
    "or \"electronics\" alone. Mattresses, junk, hazardous materials = no. " +
    'Reply ONLY JSON: {"plausible":true|false,"reason":"short"}';
  const messages = [
    { role: "system", content: system },
    { role: "user", content: text.slice(0, 800) },
  ];
  let raw = "";
  try {
    raw = await runVoiceModels(env, messages);
  } catch (e) {
    raw = "";
  }
  if (!raw) {
    return {
      plausible: false,
      reason: "Worth check unavailable — try $0.25 talk or the typed form.",
      failed: true,
    };
  }
  let parsed = extractJson(raw);
  if (!parsed) {
    try {
      parsed = JSON.parse(String(raw).trim());
    } catch (e) {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.plausible !== "boolean") {
    return {
      plausible: false,
      reason: "Worth check failed to parse — try $0.25 talk or the typed form.",
      failed: true,
    };
  }
  return {
    plausible: parsed.plausible === true,
    reason: String(
      parsed.reason ||
        (parsed.plausible ? "Plausibly worth $100+ used." : "Not clearly worth $100+ used.")
    ).slice(0, 200),
    failed: false,
  };
}

function combineItemText(data) {
  const title = String((data && (data.itemTitle || data.title)) || "").trim();
  const desc = String(
    (data && (data.itemDescription || data.description || data.item)) || ""
  ).trim();
  return [title, desc].filter(Boolean).join(" ").trim();
}

async function handleVoiceWorthCheck(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  data = data || {};
  const bot = await verifyTurnstile(request, env, data);
  if (bot) return bot;

  const combined = combineItemText(data);
  if (combined.length < 12) {
    return json(
      {
        ok: false,
        error: "item_too_short",
        message: "Describe the item more specifically (at least ~12 characters).",
      },
      400
    );
  }

  const assess = await assessItemWorth100Plus(env, combined);
  if (assess.failed) {
    return json(
      {
        ok: false,
        error: "worth_check_failed",
        plausible: false,
        reason: assess.reason,
        message: assess.reason,
      },
      503
    );
  }
  return json({
    ok: true,
    plausible: assess.plausible === true,
    reason: assess.reason,
  });
}

async function handleVoice(request, env) {
  const headers = Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders());
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: corsHeaders() });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify(Object.assign({}, VOICE_MISS, { ok: false, reason: "invalid json" })), { status: 400, headers });
  }
  const transcript = String((body && body.transcript) || "").trim();
  if (!transcript) {
    return new Response(JSON.stringify({ ok: false, reason: "transcript required", speak: "Say that again?", fields: {}, ready: false, mode: "lexical" }), { status: 400, headers });
  }
  const fields = (body && body.fields && typeof body.fields === "object") ? body.fields : {};
  const history = Array.isArray(body && body.history) ? body.history.slice(-6) : [];

  const system =
    "You help people request a FREE pickup from Still Has Value in the Salt Lake valley. We pick up items that still have resale value. Not junk hauling. Extract what they said into JSON. Never invent a phone number or zip. Accept spoken phones as digit words (five five five…) or numerals — set phone when they clearly said it; never tell them to type the phone. Remind them to use Add photos in the Talk UI for pictures — do not say filling the form is the only path. condition must be one of: working, needs minor repair, for parts, not sure. category must be one of: furniture, appliance, electronics, tools, sporting/outdoor, auto, other.\nKnown fields so far: " +
    JSON.stringify(pickVoiceFields(fields)) +
    '\nReply ONLY JSON: {"fields":{...only keys you are confident about...},"speak":"one short spoken question or recap","ready":false}\nSet ready true only when title, description (at least 15 characters), zip, name, and phone are present (in incoming fields or newly extracted). When ready, speak a one-sentence recap and ask them to confirm they want to send it (and add a photo with Add photos if missing).\nIf they said yes/submit/send it and ready, {"fields":{},"speak":"Sending your pickup request.","ready":true,"submit":true}\nIf the item is junk, a mattress, box spring, hazardous, chemicals, trash, or similar, speak that it is not a fit for free value pickup, set ready false, and do not set submit.';

  const messages = [{ role: "system", content: system }];
  for (const h of history) {
    if (!h) continue;
    const role = (h.role === "assistant" || h.role === "agent") ? "assistant" : "user";
    const text = String(h.text || h.content || "").trim();
    if (text) messages.push({ role, content: text.slice(0, 800) });
  }
  messages.push({ role: "user", content: transcript });

  let raw = "";
  try {
    raw = await runVoiceModels(env, messages);
  } catch (e) {
    raw = "";
  }

  const parsed = extractJson(raw);
  let extracted = {};
  let speak = "";
  let submit = false;
  let mode = "ai";

  if (parsed && typeof parsed === "object") {
    extracted = dropInventedContact(pickVoiceFields(parsed.fields), fields, transcript);
    speak = String(parsed.speak || "").trim();
    submit = parsed.submit === true;
  }

  if (!fieldsUseful(extracted)) {
    const lex = lexicalPickupExtract(transcript, fields);
    extracted = lex.fields || {};
    speak = lex.speak || speak;
    mode = "lexical";
    submit = lex.submit === true;
  } else {
    // Still merge lexical confirm / spoken phone if AI omitted them
    const lex = lexicalPickupExtract(transcript, Object.assign({}, fields, extracted));
    if (lex.submit === true) submit = true;
    if (!extracted.phone && lex.fields && lex.fields.phone) extracted.phone = lex.fields.phone;
    if (!extracted.zip && lex.fields && lex.fields.zip) extracted.zip = lex.fields.zip;
  }

  const merged = Object.assign({}, pickVoiceFields(fields), extracted);
  const junk = hasJunk(merged.title, merged.description);
  if (junk) {
    return new Response(JSON.stringify({
      fields: {},
      speak: "This doesn’t look like a fit for a free value pickup. We don’t haul junk, mattresses, or hazardous stuff.",
      ready: false,
      mode,
    }), { status: 200, headers });
  }

  const ready = voiceReady(merged);
  if (!speak) speak = nextMissingSpeak(merged);
  // Confirm phrases can submit from AI or lexical once fields are ready
  if (!submit && ready) {
    const lower = transcript.toLowerCase();
    if (/\b(yes|yeah|yep|send it|submit|request pickup|go ahead|please send)\b/i.test(lower)) {
      submit = true;
      if (!speak) speak = "Sending your pickup request.";
    }
  }
  const out = { fields: extracted, speak, ready, mode };
  if (submit && ready) {
    out.submit = true;
    if (!out.speak) out.speak = "Sending your pickup request.";
  }
  return new Response(JSON.stringify(out), { status: 200, headers });
}



function mintBaseUrl(env) {
  const raw = String((env && env.VOICE_MINT_URL) || FE_VOICE_MINT_URL || "").trim().replace(/\/$/, "");
  return raw || FE_VOICE_MINT_URL;
}

function truthySecret(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/** Ben staging: VOICE_BEN_TEST unlocks free test mint without CF Access (phone-friendly). Default off. */
function benTestOpen(env) {
  return truthySecret(env && env.VOICE_BEN_TEST);
}

function canAttachTestMintKey(request, env) {
  if (!(env && env.VOICE_TEST_MINT_KEY)) return false;
  if (benTestOpen(env)) return true;
  if (hasAccessSession(request)) return true;
  return false;
}

async function handleVoiceEphemeral(request, env) {
  const mintUrl = mintBaseUrl(env);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (request.method === "GET") {
    let pricing = { session_price_cents: 25 };
    try {
      const r = await fetch(mintUrl + "/v1/pricing");
      if (r.ok) pricing = await r.json();
    } catch (e) {}
    const ben = benTestOpen(env);
    const hasKey = !!(env && env.VOICE_TEST_MINT_KEY);
    const access = hasAccessSession(request);
    const free_test_available = hasKey && (ben || access);
    return json({
      ok: true,
      product: "shv-pickup",
      mint: mintUrl,
      session_price_cents: Number(pricing.session_price_cents) || 25,
      typed_form_free: true,
      ben_test_open: ben,
      free_test_available,
      talk_ui_ok: free_test_available,
      test_mint:
        "Worker secrets VOICE_TEST_MINT_KEY (+ VOICE_BEN_TEST or CF Access). Browser never sees the key.",
      note: "Public talk: $0.25 unpaid, or SHV-sponsored free after Turnstile + Worker AI confirms item is plausibly worth $100+ used (VOICE_TEST_MINT_KEY). Typed /api/pickup stays free. Ben test mint via VOICE_BEN_TEST or Access.",
      paths: ["/api/voice/ephemeral", "/api/voice-ephemeral", "/api/voice/worth-check", "/api/voice-worth-check"],
    });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }

  let data;
  try {
    data = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid_json" }, 400);
  }
  data = data || {};

  // Bot gate on SHV before any mint call
  const bot = await verifyTurnstile(request, env, data);
  if (bot) return bot;

  const mintBody = {
    product: "shv-pickup",
    turnstileToken: String(data.turnstileToken || data["cf-turnstile-response"] || "").trim(),
  };
  if (data.sessionCredit) mintBody.sessionCredit = String(data.sessionCredit);

  let mode = "public";
  // Free Ben test: VOICE_BEN_TEST (phone / no Access) OR CF Access session.
  // Never put TEST_MINT_KEY / VOICE_TEST_MINT_KEY in frontend JS.
  // SHV-sponsored public free: Turnstile (above) + client sponsored flag.
  // If item text is present, AI worth-check still runs (fail closed). Otherwise worth is judged in talk.
  const sponsoredAsk =
    data.worthConfirmed === true ||
    data.shvSponsored === true ||
    String(data.worthConfirmed || "").toLowerCase() === "true" ||
    String(data.shvSponsored || "").toLowerCase() === "true";
  if (canAttachTestMintKey(request, env)) {
    mintBody.testKey = env.VOICE_TEST_MINT_KEY;
    mode = "test";
  } else if (sponsoredAsk) {
    // Free talk: Turnstile already verified above. Worth confirmed in conversation
    // (no type-before-talk). If client already has item text, still pressure-test it.
    const combined = combineItemText(data);
    if (combined.length >= 12) {
      const assess = await assessItemWorth100Plus(env, combined);
      if (assess.failed) {
        return json(
          {
            ok: false,
            error: "worth_check_failed",
            reason: assess.reason,
            message:
              "Couldn’t verify item worth right now. Use $0.25 talk or the typed form (free).",
          },
          503
        );
      }
      if (assess.plausible !== true) {
        return json(
          {
            ok: false,
            error: "not_worth_enough",
            reason: assess.reason,
            message:
              "This doesn’t look like it’s plausibly worth $100+ used. Try $0.25 AI help or the free typed form.",
          },
          403
        );
      }
    }
    if (!(env && env.VOICE_TEST_MINT_KEY)) {
      return json(
        {
          ok: false,
          error: "sponsor_unavailable",
          message: "Free sponsored talk isn’t available right now. Try $0.25 or the typed form.",
        },
        503
      );
    }
    mintBody.testKey = env.VOICE_TEST_MINT_KEY;
    mode = "sponsored";
  }

  try {
    const r = await fetch(mintUrl + "/v1/ephemeral", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(mintBody),
    });
    const text = await r.text();
    let parsed = {};
    try {
      parsed = JSON.parse(text);
    } catch (e) {}

    if (r.status === 402 || (parsed && parsed.error === "payment_required")) {
      return json(
        {
          ok: false,
          error: "payment_required",
          session_price_cents: Number(parsed.session_price_cents) || 25,
          message:
            (parsed && parsed.message) ||
            "Talk requires prepaid session credit ($0.25). The typed form stays free.",
        },
        402
      );
    }
    if (parsed && parsed.error === "turnstile_failed") {
      return json(
        {
          ok: false,
          error: "turnstile_failed",
          message: "Voice bot check failed. Refresh, complete the check, or use the typed form (free).",
        },
        403
      );
    }
    if (!r.ok || !parsed || !parsed.value) {
      return json(
        {
          ok: false,
          error: (parsed && parsed.error) || "mint_failed",
          message: "Voice isn’t available right now. The typed form stays free.",
        },
        r.status >= 400 && r.status < 600 ? r.status : 502
      );
    }

    const freeMode = mode === "test" || mode === "sponsored";
    return json({
      ok: true,
      value: parsed.value,
      expires_at: parsed.expires_at,
      model: parsed.model || "grok-voice-latest",
      product: "shv-pickup",
      ws_url: parsed.ws_url || "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
      mode,
      session_price_cents: freeMode ? 0 : 25,
      disclose:
        mode === "test"
          ? "Test session (Ben allowlist). Talking normally costs money — this run is free for testing."
          : mode === "sponsored"
            ? "Free talk — SHV is sponsoring this session (item confirmed worth $100+ used). Typed form stays free."
            : "Talk session costs $0.25. Typed form stays free.",
    });
  } catch (e) {
    return json(
      {
        ok: false,
        error: "mint_unreachable",
        message: "Voice mint unreachable. The typed form stays free.",
      },
      502
    );
  }
}



function hasAccessSession(request) {
  if (request.headers.get("Cf-Access-Jwt-Assertion")) return true;
  const cookie = request.headers.get("Cookie") || "";
  // CF_Authorization is set when Access session cookie domain includes this host
  // (configure Access app cookie domain to .stillhasvalue.com for tracker).
  if (/(?:^|;\s*)CF_Authorization=/.test(cookie)) return true;
  if (/(?:^|;\s*)CF_AppSession=/.test(cookie)) return true;
  return false;
}

function employeeStatus(request) {
  const employee = hasAccessSession(request);
  return new Response(JSON.stringify({ employee }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/employee") {
      return employeeStatus(request);
    }
    if (url.pathname === "/api/voice") {
      return handleVoice(request, env);
    }
    if (url.pathname === "/api/voice/worth-check" || url.pathname === "/api/voice-worth-check") {
      return handleVoiceWorthCheck(request, env);
    }
    if (url.pathname === "/api/voice/ephemeral" || url.pathname === "/api/voice-ephemeral") {
      return handleVoiceEphemeral(request, env);
    }
    if (url.pathname === "/api/search") {
      return handleSearch(request, env, url);
    }
    if (url.pathname === "/api/pickup") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
      }
      if (request.method === "GET") {
        return json(pickupSchemaInfo());
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
      const source = String(data.source || "").trim().toLowerCase();
      data.source = source;
      if (isTrustedAiSource(source)) {
        if (!aiClientOk(data, request)) {
          return json({
            ok: false,
            status: "declined",
            reason: "clientToken required — copy stillhasvalue-pickup from https://stillhasvalue.com/pickup.json",
          }, 401);
        }
        if (aiRateLimited(clientIp(request))) {
          return json({ ok: false, status: "declined", reason: "too many requests, try again later" }, 429);
        }
      } else {
        const bot = await verifyTurnstile(request, env, data);
        if (bot) return bot;
      }
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
          const reference =
            String(parsed.reference || parsed.id || parsed.requestId || "").trim() ||
            ("SHV-" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase());
          return json({
            ok: true,
            status: "queued",
            notify: parsed.notify || "email",
            reference,
            id: reference,
          });
        }
        return json({ ok: false, status: "error", reason: "could not save pickup" }, 502);
      } catch (e) {
        return json({ ok: false, status: "error", reason: "could not save pickup" }, 502);
      }
    }
    let assetRes = await env.ASSETS.fetch(request);
    if (assetRes.status === 404 && url.pathname.startsWith("/shop/") && url.pathname.length > 6) {
      const rest = url.pathname.slice(5);
      if (rest && rest !== "/" && rest !== "/index.html") {
        const fallback = new URL(request.url);
        fallback.pathname = rest;
        assetRes = await env.ASSETS.fetch(new Request(fallback.toString(), request));
      }
    }
    if (/\.(png|svg|ico|jpe?g|webmanifest|json)$/i.test(url.pathname) || /icon/i.test(url.pathname)) {
      const headers = new Headers(assetRes.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(assetRes.body, { status: assetRes.status, headers });
    }
    return assetRes;
  },
};
