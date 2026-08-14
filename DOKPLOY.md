# Deploy to Dokploy

The site includes a protected Bitrix24 API endpoint at `/api/leads`. Do not use the Drop provider for this project: current Dokploy versions have a known ~1 MB ZIP request limit.

Use Dokploy with the Dockerfile:

- Provider: GitHub or Git; branch: `main`.
- Build type: Dockerfile; Dockerfile path and context path: `/`.
- Container port: `80`.
- Add the variables from `.env.example` in Dokploy's Environment section. Keep `BITRIX_WEBHOOK_URL` secret; it must never be added to the repository or JavaScript.

The endpoint creates a contact and a deal in the category selected by the lead type:

- `client` — callback modal and calculator. Normalized calculator details go to the deal field specified by `BITRIX_SITE_NOTE_FIELD`; raw form JSON is never saved in deal comments.
- `recruitment` — the «Хотите работать у нас?» form.

## Open Line chat

For the direct-manager chat, also add the `BITRIX_OPENLINE_*`, `PUBLIC_SITE_URL` and `CHAT_*` variables from `.env.example` and attach a persistent volume at `/app/data`. The exact Bitrix24 application and Contact Center steps are in `OPENLINE_SETUP.md`.
