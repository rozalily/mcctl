# Optional Dashboard

The mcctl dashboard is a read-only Node.js application that discovers Minecraft
servers from their `server.properties`, reads local service/log data, queries
Minecraft status endpoints, and presents current status, recent activity,
24-hour trends, and player skins.

It is included in the repository but is not installed by default.

## Install

From the repository root:

```bash
sudo ./install.sh --with-dashboard
sudoedit /etc/default/mcctl-dashboard
sudo systemctl enable --now mcctl-dashboard.service
```

No npm installation is required for deployment; the audited browser bundle and
its MIT license are vendored under `public/vendor/skinview3d`. Monocraft and its
SIL Open Font License are under `public/fonts`.

## Configuration

The installer creates `/etc/default/mcctl-dashboard` once and preserves it on
upgrades.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP bind address |
| `PORT` | `3010` | HTTP port |
| `BASE_PATH` | `/status` | URL prefix |
| `MINECRAFT_ROOT` | `/srv/minecraft` | Instance root |
| `MANIFEST_ROOT` | `/etc/mcctl/instances` | Trusted mcctl instance metadata |
| `PUBLIC_HOST` | `localhost` | Address displayed for players |
| `HISTORY_FILE` | `/var/lib/mcctl-dashboard/history.json` | Rolling history file |
| `SKIN_CACHE_DIRECTORY` | `/var/lib/mcctl-dashboard/skins` | Private skin cache |
| `MCCTL_NODE` | auto-detected | Absolute Node.js 22+ path when not on system PATH |

The dashboard discovers only managed directories with valid metadata in
`MANIFEST_ROOT` and uses `minecraft@<name>.service`. Older Minecraft versions
with `server.log` are detected automatically for log-based player state.

## Reverse Proxy

The service intentionally binds to loopback. Put authentication and TLS in a
reverse proxy before exposing it beyond the host. A minimal nginx location is:

```nginx
location /status/ {
    auth_basic "Minecraft status";
    auth_basic_user_file /etc/nginx/.mcctl-dashboard.htpasswd;
    proxy_pass http://127.0.0.1:3010;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}
```

Validate nginx configuration and reload it using your distribution's normal
workflow. Certificate and credential management are intentionally outside the
installer.

## Development

```bash
npm test
node server.mjs
```

Runtime history and cached skins belong in `data/`, which is ignored by Git.