# SiteCare Copilot — starter prototype

This is a separate starter project. It does not modify any existing portfolio, chatbot, or app.

## Files
- `index.html`: static frontend
- `worker.js`: Cloudflare Worker backend for one-page public SEO/health checks

## Important MVP limitations
- Uses no AI API yet; the first version reports rule-based findings.
- Checks one public HTML page only.
- Does not crawl the whole site, check Core Web Vitals, or guarantee SEO outcomes.
- Does not store customer data.
- The URL checks are defense-in-depth, not a complete SSRF security review. Do not advertise this prototype as production-secure until it has been independently tested.
- Only scan sites you own or have permission to test.

## Deploy Worker
1. Create a new Cloudflare Worker named `sitecare-copilot-api` (do not replace an existing Worker).
2. Paste the contents of `worker.js` into its editor and deploy.
3. In Worker Settings / Variables, add a plain-text variable named `ALLOWED_ORIGIN`.
   - For a GitHub Pages project site, this is the origin only, e.g. `https://yourname.github.io` (no path, no trailing slash).
   - If using a different static host, use its exact origin.
4. Redeploy if Cloudflare asks you to.
5. Copy the Worker URL, such as `https://sitecare-copilot-api.<your-subdomain>.workers.dev`.

## Deploy frontend
1. Create a separate repository called `sitecare-copilot`.
2. Upload `index.html` to the repository root.
3. In `index.html`, replace `PASTE_YOUR_CLOUDFLARE_WORKER_URL_HERE` with your Worker URL, without a trailing slash.
4. Enable GitHub Pages for this new repository using the main branch and root folder.
5. Use the resulting Pages origin (e.g. `https://yourname.github.io`) as the Worker's `ALLOWED_ORIGIN`.
6. If the Pages origin changes, update the Worker variable.

## Test safely
- First test with `https://example.com` or a site you own.
- Confirm invalid URLs are rejected.
- Confirm `http://localhost`, `http://127.0.0.1`, and private IPv4 URLs are rejected.
- Confirm a different browser origin receives a 403.
- Do not enter credentials or scan private/internal services.

## Next phase
Before adding AI, accounts, saved reports, or payments, add rate limiting, stronger SSRF controls and monitoring, then test tenant authorization and data deletion. This starter deliberately has no login or database.
