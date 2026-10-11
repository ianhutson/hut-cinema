# Hut Cinema

A tiny two-tab web app for managing the movie library on the-hut.

- **Add** — search any movie, one tap adds it to Radarr (monitored, auto-search,
  saved to whichever Radarr root folder has the most free space).
- **Remove** — poster grid of the library. Removing is instant in the UI (big
  red X over the poster, Undo button) but files are only deleted ~12 hours
  later by a background worker. Undo before then costs nothing — no delete, no
  re-download. When the worker runs it also removes the movie's active
  downloads from the torrent client, deletes the files, and adds a Radarr list
  exclusion so imports/scripts can't re-add it. "Add back" undoes even that.

The server proxies Radarr so the API key never reaches the browser, and the
app requires a password (APP_PASSWORD) with a 60-day session cookie.

## Run it on the NAS

Copy this folder to the NAS (e.g. /share/Docker/hut-cinema), then:

    cd /share/Docker/hut-cinema
    sudo docker build -t hut-cinema .
    sudo docker rm -f hut-cinema 2>/dev/null
    sudo docker run -d --name hut-cinema -p 8484:8484 \
      -e RADARR_URL=http://10.0.0.173:17878 \
      -e RADARR_API_KEY=YOUR_RADARR_API_KEY \
      -e APP_PASSWORD='YOUR_APP_PASSWORD' \
      -v /share/Docker/hut-cinema/data:/data \
      --restart unless-stopped \
      hut-cinema

Open http://10.0.0.173:8484

The -v /data mount matters: it's where pending removals are stored, so the
12-hour delete queue survives container restarts and rebuilds.

Radarr's API key: Radarr → Settings → General → Security → API Key.

Optional env vars:
- DELETE_AFTER_HOURS — undo window before files are really deleted (default 12)
- SESSION_DAYS — how long a login lasts (default 60)
- QUALITY_PROFILE_ID — force a Radarr quality profile (defaults to the first)
- PORT — listen port (default 8484)

## Notes

- Removal ends in Radarr's "delete files + add list exclusion", so the
  Letterboxd sync will skip removed movies once run.js checks
  /api/v3/exclusions before adding (small edit).
- During the undo window the movie is unmonitored in Radarr but still in the
  library, so the sync also won't re-add it in that window.
- Safe to expose via the cloudflared tunnel — the app's own password protects it.
