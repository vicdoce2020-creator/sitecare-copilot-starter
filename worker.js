const MAX_URL_LENGTH = 2048;
const MAX_HTML_BYTES = 1024 * 1024; // Read at most 1 MiB of HTML.
const TIMEOUT_MS = 8000;

// For the first test, set ALLOWED_ORIGIN to your exact deployed frontend origin,
// for example https://yourname.github.io. Do not use "*" for production.
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGIN || "";
  const headers = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
  if (allowed && origin === allowed) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}
function json(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
  });
}
function isPrivateIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p) || Number(p) > 255)) return false;
  const [a,b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function validateUrl(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) throw new Error("Enter a valid website URL.");
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a complete URL, such as https://example.com."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS websites are supported.");
  if (url.username || url.password) throw new Error("URLs containing usernames or passwords are not allowed.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:") ||
      isPrivateIPv4(host) || host === "0.0.0.0") {
    throw new Error("Private or local network addresses cannot be scanned.");
  }
  // Do not follow redirects in this MVP; this prevents a redirect to a different host.
  url.hash = "";
  return url;
}
async function readLimited(response, maxBytes) {
  if (!response.body) return { text: "", bytesRead: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0, truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk); total += chunk.byteLength;
      if (value.byteLength > remaining) { truncated = true; break; }
    }
    if (total >= maxBytes) truncated = true;
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(joined), bytesRead: total, truncated };
}
function extractTag(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i");
  const match = html.match(re);
  return match ? match[1].replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim() : "";
}
function extractMetaDescription(html) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (/\bname\s*=\s*["']description["']/i.test(tag)) {
      const match = tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    }
  }
  return "";
}
function extractCanonical(html) {
  const tags = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (/\brel\s*=\s*["']canonical["']/i.test(tag)) {
      const match = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
    }
  }
  return "";
}
function add(findings, level, title, detail) { findings.push({ level, title, detail }); }

async function handleScan(request, env) {
  let payload;
  try { payload = await request.json(); } catch { return json({ error: "Request body must be valid JSON." }, 400, corsHeaders(request, env)); }
  let url;
  try { url = validateUrl(payload?.url); } catch (e) { return json({ error: e.message }, 400, corsHeaders(request, env)); }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  let response;
  try {
    response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "User-Agent": "SiteCareCopilot-Prototype/0.1 (+public-page-audit)" }
    });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "The website took too long to respond." : "Could not reach that website. Check the URL and try again.";
    clearTimeout(timeout);
    return json({ error: msg }, 502, corsHeaders(request, env));
  }
  clearTimeout(timeout);
  const responseTimeMs = Date.now() - started;
  const headers = corsHeaders(request, env);
  const status = response.status;
  const findings = [];

  if (status >= 300 && status < 400) {
    add(findings, "warn", "Website redirects", `The URL returned HTTP ${status}. This prototype does not follow redirects. Try the final HTTPS URL directly.`);
    return json({ url: url.toString(), httpStatus: status, responseTimeMs, bytesRead: 0, findings }, 200, headers);
  }
  if (!response.ok) {
    add(findings, "bad", "Website did not return a successful response", `The page returned HTTP ${status}. Confirm the URL and check whether the site blocks automated requests.`);
    return json({ url: url.toString(), httpStatus: status, responseTimeMs, bytesRead: 0, findings }, 200, headers);
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("text/html")) {
    add(findings, "warn", "Response is not HTML", `The server returned "${contentType || "an unknown content type"}". Try the URL of a regular web page.`);
    return json({ url: url.toString(), httpStatus: status, responseTimeMs, bytesRead: 0, findings }, 200, headers);
  }

  const { text: html, bytesRead, truncated } = await readLimited(response, MAX_HTML_BYTES);
  const title = extractTag(html, "title");
  const description = extractMetaDescription(html);
  const canonical = extractCanonical(html);
  const h1Matches = html.match(/<h1\b[^>]*>/gi) || [];
  const viewport = /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/i.test(html);
  const htmlLang = /<html\b[^>]*\blang\s*=\s*["'][^"']+["']/i.test(html);

  add(findings, "good", "Website responded", `The page returned HTTP ${status} in ${responseTimeMs} ms.`);
  if (!title) add(findings, "warn", "Missing page title", "No HTML <title> was found in the inspected page. Add a unique, descriptive title.");
  else if (title.length < 10 || title.length > 60) add(findings, "warn", "Review page title length", `The title is ${title.length} characters. Review whether it clearly describes this page; length alone does not determine ranking.`);
  else add(findings, "good", "Page title found", `Title: "${title}"`);
  if (!description) add(findings, "warn", "Missing meta description", "No meta description was found. Consider writing a concise, page-specific summary; search engines may choose their own snippet.");
  else add(findings, "good", "Meta description found", `Found a meta description (${description.length} characters). Review its relevance and clarity.`);
  if (h1Matches.length === 0) add(findings, "warn", "No H1 heading detected", "No H1 opening tag was found in the inspected HTML. Confirm the page has a clear main heading.");
  else if (h1Matches.length > 1) add(findings, "warn", "Multiple H1 headings detected", `Found ${h1Matches.length} H1 opening tags. This is not automatically an SEO error; review the page structure.`);
  else add(findings, "good", "H1 heading detected", "One H1 opening tag was found in the inspected HTML.");
  if (!viewport) add(findings, "warn", "Viewport meta tag not detected", "A responsive viewport declaration was not found in the inspected HTML. Verify mobile rendering.");
  else add(findings, "good", "Viewport meta tag found", "A viewport declaration was found; this alone does not prove the page is mobile-friendly.");
  if (!htmlLang) add(findings, "warn", "HTML language not detected", "The opening HTML tag did not declare a language. Adding a correct lang attribute can help assistive technologies.");
  else add(findings, "good", "HTML language declared", "A language attribute was found on the HTML element.");
  if (canonical) add(findings, "good", "Canonical link found", `Canonical reference: ${canonical}`);
  else add(findings, "warn", "Canonical link not detected", "No canonical link was found in the inspected HTML. It may be appropriate for some pages but is not required for every page.");
  if (truncated) add(findings, "warn", "Page inspection was limited", "Only the first 1 MiB was inspected. Some markup near the end of the document may not have been checked.");
  if (responseTimeMs > 3000) add(findings, "warn", "Slow response in this test", "The initial response took over 3 seconds from this scan environment. This is only a rough server-response observation, not a full performance test.");

  return json({ url: url.toString(), httpStatus: status, responseTimeMs, bytesRead, findings }, 200, headers);
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (url.pathname !== "/scan") return json({ error: "Not found. Use POST /scan." }, 404, headers);
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { ...headers, Allow: "POST, OPTIONS" });
    const origin = request.headers.get("Origin") || "";
    if (!env.ALLOWED_ORIGIN || origin !== env.ALLOWED_ORIGIN) {
      return json({ error: "This website origin is not allowed." }, 403, headers);
    }
    const contentLength = Number(request.headers.get("Content-Length") || "0");
    if (contentLength > 4096) return json({ error: "Request is too large." }, 413, headers);
    return handleScan(request, env);
  }
};
