# EVE Market Master

Local-first EVE Online market tooling. The app is intentionally plain HTML/CSS/JS with D3 as the planned visualization dependency.

## Development Setup

1. Copy `.env.example` to `.env`.
2. Register an EVE developer application and set the callback URL to `http://localhost:8787/development/sso/`.
3. Fill in `EVE_CLIENT_ID`. `EVE_CLIENT_SECRET` is optional for PKCE, but the local dev server can use it for non-PKCE experiments later.
4. Start the local server:

```bash
npm run dev
```

Open:

- Main app shell: `http://localhost:8787/app/`
- EVE SSO test page: `http://localhost:8787/development/sso/`

## Useful Commands

```bash
npm run esi:status
npm run esi:markets -- --region 10000002 --type 34
npm run sde:fetch
npm run sde:extract-app-data
```

The SDE command downloads the current official JSON Lines SDE into `development/sde/data/raw/` and extracts it into `development/sde/data/extracted/`. These large generated files are ignored by git.

## Current External Sources

- ESI: `https://esi.evetech.net/latest/`
- SSO metadata: `https://login.eveonline.com/.well-known/oauth-authorization-server`
- SDE latest metadata: `https://developers.eveonline.com/static-data/tranquility/latest.jsonl`
- SDE latest JSON Lines zip: `https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip`
