# @pipeworx/planetary-computer

Earth-observation imagery catalogue from Microsoft's Planetary Computer — search
its open satellite and environmental collections (Sentinel, Landsat, NAIP,
Daymet, ERA5, biodiversity) by area and date and get item ids, footprints, dates
and asset URLs.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `planetary_computer_collections(contains?, prefix?, limit?)` — the datasets in
  the catalogue with licence, extent and date range. Call this first: search
  refuses a query that names no collection.
- `planetary_computer_collection(collection_id)` — one dataset in full,
  including the asset keys (bands) its items carry.
- `planetary_computer_search(collections, bbox?, datetime?, ids?, limit?, max_assets?)`
  — which scenes cover an area on given dates, with cloud cover and per-band
  asset URLs.

## Auth

Keyless for metadata. Asset BYTES are a separate step: most collections require
a short-lived read token from
`https://planetarycomputer.microsoft.com/api/sas/v1/token/{collection}` (itself
keyless, ~1 hour) appended to the href. The href alone is not a working download
link and reads like a dead one if you try it cold.

## Data sources

- <https://planetarycomputer.microsoft.com/api/stac/v1> — STAC API 1.0.

Shared client: `shared/src/stac.ts` (`stacCollections` / `stacCollection` /
`stacSearch`), also used by `earth-search`, `copernicus-dataspace` and
`meteoswiss`. Fix paging or an error message there and all four improve.

## Traps

- `POST /search` with no `collections` answers **HTTP 422 `collection is
  required`** — a bare string naming no fix. The shared client converts it into
  a message that names `planetary_computer_collections`.
- Collection ids are **per-catalogue**. `sentinel-2-l2a` here is
  `sentinel-2-c1-l2a` on Earth Search. Passing a sibling catalogue's id returns
  an empty result, not an error.
- `GET /collections` pages; the shared client follows `rel="next"` and reports
  `truncated` when it stops.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "planetary-computer": {
      "url": "https://gateway.pipeworx.io/planetary-computer/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/planetary-computer/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/planetary_computer_collections \
  -H 'Content-Type: application/json' \
  -d '{"contains":"sentinel","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/planetary_computer_collections`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "planetary-computer": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-planetary-computer"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-planetary-computer
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Planetary Computer data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
