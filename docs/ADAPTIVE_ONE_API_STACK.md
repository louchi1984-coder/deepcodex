# deepcodex adaptive one-api stack

Target topology:

```text
deepcodex.app
  -> adaptive translator :8282
  -> one-api :13000
  -> DeepSeek/OpenAI/Claude/etc. channels
```

## Ports

- Codex talks only to `http://127.0.0.1:8282`.
- The translator talks only to `http://127.0.0.1:13000/v1`.
- one-api owns provider keys, channel routing, rate limits, and usage stats.

## First start

The default one-api web UI is not part of the normal flow. Use the local
minimal bootstrap:

```bash
cp one-api/.env.example one-api/.env
perl -0pi -e 's/^DEEPSEEK_API_KEY=.*/DEEPSEEK_API_KEY=sk-your-deepseek-key/m' one-api/.env
./scripts/setup-one-api-minimal.sh
```

That script:

- starts one-api on `127.0.0.1:13000`;
- creates the initial root access token from `ONE_API_ROOT_ACCESS_TOKEN`;
- creates or updates a `deepcodex` DeepSeek channel;
- creates a translator relay token;
- writes the relay token to `codex-home-deepseek-app/one-api-token`.

Then launch:

```bash
./scripts/start-adaptive-oneapi-codex.sh
```

The launcher also runs the minimal bootstrap if the relay token file is missing.

The one-api UI remains available at `http://127.0.0.1:13000` for advanced
inspection, but it is not required for setup.

## Optional dokobot setup

The translator can provide replacement web tools when the upstream does not support hosted web search. The strong path uses dokobot/doko with a real Chrome browser, so it is an extra local dependency.

Install and check:

```bash
npm install -g @dokobot/cli
dokobot install-bridge
./scripts/check-dokobot.sh
```

Local mode requires Chrome open with the Dokobot extension enabled. Remote mode is possible instead, but requires `DOKO_API_KEY` configured with `dokobot config`.

## Translator responsibility

- Convert Codex Responses requests to OpenAI-compatible Chat Completions.
- Detect upstream capabilities and cache a provider profile.
- Preserve local tool surfaces:
  - `function` tools are forwarded as callables.
  - `custom` tools such as `apply_patch` keep freeform/grammar metadata in the routing table.
  - `namespace` tools are flattened to callable Chat tools and mapped back on response.
- Drop hosted/account-bound tools such as `web_search` and `image_generation` when the upstream lacks native hosted tools.
- Inject translator-owned internal tools only when allowed and only outside compact mode.
- For local web access, prefer the translator internal tools:
  - `web_search` uses dokobot/doko to open normal search-engine result pages in a real Chrome browser, then reads the rendered page. It is not relying on a separate dokobot search engine.
  - `web_fetch` uses dokobot/doko for rendered pages and SPAs when available, and falls back to a simple urllib fetch.
  - Browser-read search falls back to urllib when dokobot is missing, the local bridge is down, the search page is blocked by verification/captcha, the output is empty/too short, or the command times out.
- The injected system prompt tells the model when to search, when not to search, to fetch primary pages after search, to avoid guessing on weak evidence, and to include source URLs when web tools affect the answer.
- Treat `/responses/compact` as a separate request mode with no tools.

## one-api responsibility

- Manage API keys and provider channels.
- Decide which provider/channel handles each Chat Completions request.
- Track usage and rate limits.
- Return OpenAI-compatible Chat Completions responses to the translator.
