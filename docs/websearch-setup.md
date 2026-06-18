# Web search & read — setup

Since **0.7.0-alpha** the Familiar can search the web and read pages, via two tools —
`web_search` and `read_webpage`. Both are **opt-in** and need a local, self-hosted
[SearXNG](https://docs.searxng.org/) instance you run yourself. Nothing is enabled, and no
egress happens, until you turn it on in Settings.

## 1. Run SearXNG

SearXNG is lightweight and runs well in Docker. A minimal start:

```bash
docker run --rm -d \
  --name searxng \
  -p 8080:8080 \
  -v "$PWD/searxng:/etc/searxng" \
  searxng/searxng
```

That writes a default config into `./searxng/` on first boot. Edit `./searxng/settings.yml` so
the **JSON API** is on (it is off by default) and a `secret_key` is set (SearXNG refuses to
serve the API without one):

```yaml
search:
  formats:
    - html
    - json          # mandatory — the Familiar reads results as JSON

server:
  secret_key: "change-me-to-a-long-random-string"
```

Restart the container after editing (`docker restart searxng`). Confirm the API answers:

```bash
curl "http://localhost:8080/search?q=test&format=json"
```

You should get JSON with a `results` array. If you get HTML or a 403, the `json` format or the
`secret_key` is missing.

> SearXNG's port (8080) is unrelated to Proto-Familiar's own port (8742) — they don't clash.

## 2. Enable it in Proto-Familiar

In the sidebar **Tools** section:

- **Web search & read** — turn on. Until this is checked, `web_search` / `read_webpage` are not
  even advertised to the Familiar.
- **SearXNG base URL** — defaults to `http://localhost:8080`; change if you run it elsewhere.
- **Search results to keep** — how many rows `web_search` returns (default 5).
- **Max page chars read** — caps the markdown `read_webpage` returns (default 15000).

These settings sync across your devices like the rest of your preferences.

## 3. What the Familiar can do with it

- **`web_search`** — runs a query through SearXNG and gets back titles, snippets, and links.
- **`read_webpage`** — opens one of those links, strips it down to clean markdown
  (`linkedom` + `@mozilla/readability` + `turndown`), and reads it. The content is stamped with
  its source URL and the date read, and framed as untrusted external data.
- **Keeping what it reads** — a page the Familiar reads stays in the conversation for the rest
  of the session. When something is worth keeping past it, the Familiar saves the gist (with its
  source) to a tome via `save_to_tome`, so it carries into future sessions.

## Safety

`read_webpage` will only open **public** http/https addresses. It refuses loopback, private-LAN,
link-local, and cloud-metadata targets (and validates the resolved IP, not just the hostname, so
a name pointing at a private address is caught too), follows redirects manually re-checking every
hop, and times out on slow hosts. This keeps a poisoned search result from steering the Familiar
at something internal.

## Turning it off

- Uncheck **Web search & read** in Settings, or
- Set the hard env kill-switch before launch: `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` — forces both
  tools off regardless of the toggle.
