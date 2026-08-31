const FORMSUBMIT = "https://formsubmit.co/ajax/ben@noveltie.com";

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

function prescreen(data) {
  const photoCount = Number(data.photoCount) || 0;
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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
      const check = prescreen(data || {});
      if (!check.ok) {
        return json({ ok: false, status: "declined", reason: check.reason });
      }
      const title = String(data.title || "").trim();
      const zip = zipOf(data.zip);
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
        photoCount: Number(data.photoCount) || 0,
        _subject: data._subject || ("SHV pickup request: " + title + " (" + zip + ")"),
      };
      try {
        const r = await fetch(FORMSUBMIT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
        const text = await r.text();
        let ok = r.ok;
        try {
          const parsed = JSON.parse(text);
          if (parsed && (parsed.success === true || parsed.success === "true")) ok = true;
        } catch (e) {}
        if (ok) {
          return json({ ok: true, status: "queued", notify: "email" });
        }
        return json({ ok: true, status: "queued", notify: "email-pending" });
      } catch (e) {
        return json({ ok: true, status: "queued", notify: "email-pending" });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
