# Development Workspace

This folder is for API exploration, SDE ingestion, and local authentication experiments. Generated data and tokens should stay out of git.

## ESI Probes

Reusable client:

- `development/esi/esi-client.mjs`

Commands:

```bash
npm run esi:status
npm run esi:markets -- --region 10000002 --type 34 --limit 5
node development/esi/probe.mjs character-orders --character 123456789 --token access_token_here
node development/esi/probe.mjs route --path /markets/10000002/history/ --token optional_token
```

The client adds `datasource=tranquility`, `X-Compatibility-Date`, a user agent, pagination support, and optional bearer tokens.

## SDE

Downloader:

```bash
npm run sde:fetch
```

Current official source:

- Metadata: `https://developers.eveonline.com/static-data/tranquility/latest.jsonl`
- Latest JSONL zip: `https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip`

Local output:

- Raw zip: `development/sde/data/raw/`
- Full extracted export: `development/sde/data/extracted/`

The extracted SDE is intentionally ignored by git. Use `npm run sde:extract-app-data` to cut smaller browser-ready JSON files into `app/data/`.

## SSO Test Page

Start the server:

```bash
npm run dev
```

Open `http://localhost:8787/development/sso/`.

The page uses Authorization Code with PKCE. It stores the token response in local browser storage and displays the decoded character ID/name claims for development testing. Register the exact redirect URI in the EVE developer portal:

```text
http://localhost:8787/development/sso/
```

Treat access and refresh tokens as private local credentials.
