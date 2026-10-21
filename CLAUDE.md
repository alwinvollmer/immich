# CLAUDE.md — Immich fork (alwinvollmer/immich)

Personal fork of Immich. Only the **server image (server + web)** is customised; the
machine-learning image and the mobile app are stock. Fork model, update procedure and
the **roadmap / todo list** live in `CUSTOM.md` — read it first and keep it current.
MCP memory project: `immich`.

## Conventions

- Branch `custom` = upstream release tag + our commits. Never commit to `main`.
- Mark every change to upstream code with a `custom:` comment. Prefer NEW files
  (own services, event listeners `@OnEvent`, components, managers) over editing
  upstream files — every upstream edit is merge cost on each release.
- No database schema changes unless unavoidable (going back to stock must stay possible).
  Use existing tables (`asset_metadata`, config) instead.
- When a change alters upstream behaviour, update the affected upstream tests to the new
  behaviour and add tests for the new code (mark them `custom:`).
- Git identity is repo-local: `8074927+alwinvollmer@users.noreply.github.com`.
  NEVER commit with the work email (it had to be force-pushed out once).
- User-facing text may be plain English (no i18n keys needed for fork-only strings).

## Local setup (once per clone)

    pnpm install --frozen-lockfile --filter 'immich-web...' --filter 'immich...'
    pnpm --filter @immich/plugin-sdk build    # the server build needs it
    pnpm --filter @immich/sdk build           # the web needs it (rebuild after SDK changes)

API changes (new DTO fields/params) need a regenerated spec + TypeScript SDK:

    cd server && pnpm run build && node ./dist/bin/sync-open-api.js
    cd .. && npx -y oazapfts@7.5.0 --optimistic --argumentStyle=object --useEnumType --allSchemas \
      open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts
    # do NOT regenerate the Dart client (the mobile app stays stock)

## Checks — run ALL of them BEFORE every commit

Server (`cd server`): `pnpm run build`; `pnpm test -- --run` (uses test/vitest.config.mjs —
plain `npx vitest` lacks the `src/` alias); `npx eslint --max-warnings 0 <files>`;
`npx prettier --check <files>`.

Web (`cd web`): `pnpm run check:svelte`; `pnpm run check:typescript`;
`npx eslint --max-warnings 0 --rule 'tscompat/tscompat: off' <files>`; `npx prettier --check <files>`
(`--write` / `eslint --fix` for Tailwind class order); `npx vitest run`.

⚠️ `eslint --fix` silently rewrites `http://` URLs to `https://` (rule `unicorn/prefer-https`),
in code AND tests alike, so the tests still pass. Plain-HTTP LAN services (the upscaler) need an
`// eslint-disable-next-line unicorn/prefer-https`. After any `--fix`, check `git diff` for changed URLs.

Known local-only failures (also on pristine upstream, ignore):
- eslint `tscompat/tscompat` crashes ("Cannot read properties of undefined (reading 'Class')")
  → lint with the rule off, and avoid new JS APIs by hand (no `Array.toSorted`, etc.).
- 20 failures in `web/src/lib/utils/thumbnail-util.spec.ts` (locale).

## Build & deploy

1. `git push` on `custom` → `.github/workflows/custom-server.yml` builds
   `ghcr.io/alwinvollmer/immich-server:v<server/package.json version>-custom-<7-char sha>` (~6 min,
   amd64, private package). Docs-only pushes (`**.md`) do not build. Watch with
   `gh run watch <id> -R alwinvollmer/immich --exit-status`.
2. nieke (Windows, SSH lands in cmd.exe):
   `docker --config C:\docker\immich\.docker pull ghcr.io/alwinvollmer/immich-server:<tag>`
   (that config holds the read:packages token; the default credential helper fails over SSH).
3. Change ONE line in `C:\docker\immich\.env`: `IMMICH_SERVER_IMAGE=…:<tag>` (CRLF file —
   edit with a byte-exact replace, never sed).
4. `cd C:\docker\immich && docker compose up -d --pull never immich-server`.
5. Verify: `GET /api/server/about` → `buildImage` = the tag; check `docker logs immich_server`.
   Schema-changing upstream updates: DB backup first (`POST /api/jobs {"name":"backup-database"}`).

`IMMICH_VERSION` in that `.env` pins the stock ML image to the same release — bump it when
merging a new upstream release. Back to stock = point `IMMICH_SERVER_IMAGE` at
`ghcr.io/immich-app/immich-server:<version>`.

## nieke / data rules

- API: `http://192.168.1.249:2283/api`, key = `IMMICH_API_KEY` in
  `C:\temp\claude-immich\retired\immich-api-worker\.env` (the retired worker's folder, moved out of
  `C:\docker` 2026-10-21; read it per command; scratch files get wiped).
- DB: write SQL to a file, `scp` to `C:\temp\claude-immich\`, `docker cp` into `immich_postgres`,
  `psql -f` (inline quoting through cmd.exe is fragile).
- Everything we generate on nieke goes to `C:\temp\claude-immich\` — never into `C:\docker\`.
- Bulk data changes (visibility, albums, trash, stacks): dry run first, save the affected ID
  list to `C:\temp\claude-immich\` for rollback, confirm with the user, test one item, then run.
- Trash retention is 90 days.

## External pieces (still outside the fork)

- booru-tagger (`C:\docker\booru-tagger`, :7860, CPU): sources in `custom/booru-tagger/` — copy
  them to `C:\docker\booru-tagger\tagger` and `docker compose build` there. `/v2/analyze`
  (pixai-tagger-v1.0 + head detection + CCIP), `/v2/cluster`, `/v2/info`; legacy `/tag` (v0.9) only
  for the old worker (`ENABLE_V1=0` turns it off). For big remaps run the GPU variant
  (`Dockerfile.gpu`, `--gpus all`, same model file → same tags) on another port and point
  `IMMICH_TAGGER_URL` at it; daily use stays on CPU (~16 s/image, ~4.6 GB RAM) to keep VRAM free.
  ⚠️ Docker Desktop's build proxy on nieke returns 502 for Fastly hosts (PyPI, deb.debian.org):
  build with `--build-arg HTTP_PROXY= --build-arg HTTPS_PROXY= --build-arg http_proxy= --build-arg https_proxy=`.
  deb.debian.org is unreachable from containers at all → images are Ubuntu-based.
- immich-api-worker: RETIRED and removed 2026-10-21 (compose down, image removed, workflow
  "Danbooru auto-tag (webhook)" deleted — backup C:\temp\claude-immich\workflow-danbooru-autotag-2026-10-21.json;
  folder moved to C:\temp\claude-immich\retired\immich-api-worker).
- anime-upscaler (:7085, CPU mode) stays separate.
  anime-upscaler (`C:\docker\anime-upscaler\main.py`, bind-mounted → `docker compose restart`) has a
  job API: `POST /jobs` (image, outscale) → id; `GET /jobs/{id}` (state, progress, tilesDone/Total,
  position); `GET /jobs/{id}/result`; `DELETE /jobs/{id}` (a running job stops before its next tile).
  Used by UpscaleService (`IMMICH_UPSCALER_URL`, default `http://host.docker.internal:7085`) and the
  desktop's `~/.local/bin/wallpaper-upscale`.

## Behaviour the fork relies on (don't break)

- Stack rule: only a stack's cover is ever in albums (StackAlbumService + AlbumService refusal,
  error `validation`); the stack bar shows all non-locked members; album/archive/photos
  timelines request `withStacked`.
- Photos album filter (`albumIds`, ANY semantics) with localStorage selection, default "Camera".
  Album-filtered timelines skip live websocket inserts (like `albumId` timelines).
- Uploads into albums: drop files on a sidebar album or a Photos album chip (`use:albumDropTarget`;
  the global drop overlay is a click-through hint), or Ctrl+V → `PasteUploadModal` (optional album).
  Nothing is filed into Desktop automatically any more. Sidebar shows 5 recent albums.
- Danbooru tagging (`DanbooruService`, env `IMMICH_DANBOORU_*` / `IMMICH_TAGGER_URL` in `C:\docker\immich\.env`):
  loop in the microservices worker over images without a `custom.danbooru` marker for the tagger's
  current model (newest first). Tags + description + `::series:` + `danbooru`; characters → People
  with head boxes (CCIP vectors in `/data/custom/ccip/<assetId>.json`, NOT asset_metadata — that
  syncs to the phone). A marker-less image loses all its tags first; later runs only replace the
  tags in the marker. Maintenance pass when idle (≤ every 12 h): pair/match unassigned heads,
  OPTICS-cluster the rest into unnamed people. Character names = Danbooru tags with `_` → space.
- Immich face detection only on camera photos (`IMMICH_FACES_CAMERA_ONLY=1`: EXIF make required).
- Upscale: viewer ⋮ "Upscale ×2/×4" → `UpscaleService` (in-memory jobs, `on_upscale_update`
  websocket events) → `UpscalePanel`; result = new stack cover with the original's metadata/tags.
- Mobile app: background backup never assigns folder albums (only foreground sync does);
  the "sync remote deletions" app setting breaks local sync → keep it OFF. Pasting several files
  copied in Nautilus only yields the first one (Firefox/Zen limitation) → drag & drop instead.
- Current deploy and roadmap state: `CUSTOM.md`; MCP memory project `immich` has the history.
