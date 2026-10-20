# Custom Immich server (fork)

Branch `custom` = an upstream release tag + our commits. Only the server image
(server + web) is customised; machine-learning stays stock. No database schema
changes unless unavoidable, so going back to stock Immich always works.

- Repo: https://github.com/alwinvollmer/immich (public fork), upstream remote `upstream`
- Image: `ghcr.io/alwinvollmer/immich-server` (private), tags `<release>-custom-<sha>` and `custom`
- Built by `.github/workflows/custom-server.yml` on every push to `custom` (amd64 only).
  All upstream workflows are disabled in the fork (`gh workflow list --all -R alwinvollmer/immich`).
- Runs on nieke: `C:\docker\immich` (compose); pull auth lives in `C:\docker\immich\.docker\config.json`
  (no credsStore: the Windows credential helper fails over SSH).

## Our commits

    git log --oneline $(git describe --tags --abbrev=0)..custom

## Update to a new upstream release

    git fetch upstream --tags
    git merge vX.Y.Z            # resolve conflicts in our commits
    git push                    # builds the image
    # DB backup first: POST /api/jobs {"name":"backup-database"}
    # nieke: docker --config C:\docker\immich\.docker pull ghcr.io/alwinvollmer/immich-server:<tag>
    #        cd C:\docker\immich && docker compose up -d

Keep the machine-learning image on the SAME release as the merged tag.

## Back to stock

Point `immich-server` in `C:\docker\immich\docker-compose.yml` back to
`ghcr.io/immich-app/immich-server:${IMMICH_VERSION}` with a version >= the merged tag,
then `docker compose up -d`.
