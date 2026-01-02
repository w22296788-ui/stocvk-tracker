# Family Investment League 2026

Static site + Cloudflare Pages Function that fetches daily history from Twelve Data.

## Deploy (Cloudflare Pages)
1. Framework preset: None
2. Build command: (empty)
3. Build output directory: /
4. Environment variables:
   - TWELVE_DATA_API_KEY
   - CACHE_TTL_SECONDS (optional, default 86400)
   - MAX_SYMBOLS_PER_REQUEST (optional, default 8)
   - BATCH_DELAY_SECONDS (optional, default 70)
5. Redeploy

## Local dev (optional)
1. Copy env vars:
   - `cp .env.local .dev.vars`
2. Start dev server:
   - `npx wrangler pages dev . --local --port 8788`

## Config
- League start date:
  - `index.html` (LEAGUE_START_DATE)
  - `functions/api/league.js` (START_DATE)
- Participants list: `index.html` (PARTICIPANTS)

## Credits
- Each cache refresh calls Twelve Data once per ticker.
- If your plan is limited (e.g. ~100 credits/month), set `CACHE_TTL_SECONDS=604800` (7 days).
- If your plan has a per-minute cap, keep `MAX_SYMBOLS_PER_REQUEST` at or below that limit and
  set `BATCH_DELAY_SECONDS` to 60+ so batches stay under the minute window.
