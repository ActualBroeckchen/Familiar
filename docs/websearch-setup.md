# Web search & read

Since **0.7.0-alpha** the Familiar can search the web and read pages, via two tools —
`web_search` and `read_webpage`.

## It works out of the box

There is **nothing to install, start, or configure.** In the sidebar **Tools** section, turn on
**Web search & read** — that's the whole setup. The Familiar searches using a built-in, keyless
backend (it reads DuckDuckGo results directly), so the moment the box is checked, it can search.

Optional knobs in the same section:

- **Search results to keep** — how many rows `web_search` returns (default 5).
- **Max page chars read** — caps the markdown `read_webpage` returns (default 15000).

These sync across your devices like the rest of your preferences.

## What the Familiar can do with it

- **`web_search`** — runs a query and gets back titles, snippets, and links.
- **`read_webpage`** — opens one of those links, strips it down to clean markdown
  (`linkedom` + `@mozilla/readability` + `turndown`), and reads it. The content is stamped with
  its source URL and the date read, and framed as untrusted external data.
- **Keeping what it reads** — a page the Familiar reads stays in the conversation for the rest
  of the session. When something is worth keeping past it, the Familiar saves the gist (with its
  source) to a tome via `save_to_tome`, so it carries into future sessions.

## Safety

`read_webpage` only opens **public** http/https addresses. It refuses loopback, private-LAN,
link-local, and cloud-metadata targets (validating the resolved IP, not just the hostname, so a
name pointing at a private address is caught too), follows redirects manually re-checking every
hop, and times out on slow hosts. This keeps a poisoned search result from steering the Familiar
at something internal.

## Turning it off

- Uncheck **Web search & read** in Settings, or
- Set the hard env kill-switch before launch: `PROTO_FAMILIAR_WEBSEARCH_DISABLED=1` — forces both
  tools off regardless of the toggle.

---

## Advanced: use your own SearXNG (optional)

The built-in search is keyless and convenient, but a shared keyless backend can rate-limit under
heavy use. If you want a heavier-duty, fully-controlled backend, you can run your own
[SearXNG](https://docs.searxng.org/) and point Proto-Familiar at it — **this is entirely
optional and most people never need it.**

1. Run SearXNG (Docker is easiest):
   ```bash
   docker run --rm -d --name searxng -p 8080:8080 \
     -v "$PWD/searxng:/etc/searxng" searxng/searxng
   ```
2. Enable the JSON API in `./searxng/settings.yml` (off by default) and set a `secret_key`
   (SearXNG won't serve the API without one):
   ```yaml
   search:
     formats:
       - html
       - json          # mandatory — the Familiar reads results as JSON
   server:
     secret_key: "change-me-to-a-long-random-string"
   ```
   Restart (`docker restart searxng`) and confirm:
   ```bash
   curl "http://localhost:8080/search?q=test&format=json"
   ```
3. In Settings → Tools, put the URL in **Custom search backend** (e.g. `http://localhost:8080`).
   Leave it blank to use the built-in search.
