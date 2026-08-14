# HypixelProxy

A super simple proxy for the Hypixel API, only to be used by contributors working on the same registered Hypixel project. 

Use of this project (or even just a similar idea) to share an API key between unrelated users/projects, would be a violation of the
[Hypixel API policy](https://developer.hypixel.net/policies/).

## Use Case

Proxying the Hypixel API in the following limited use case has been confirmed to be fine by Hypixel admins assuming all the following are true:

1. You (or a core contributor of your app) have an approved Hypixel API project and API Key
2. You (or a core contributor of your app) need a key for local development on your app, and don't want to have your sensitive API key on your local system
3. Use of this key will in no way be used dishonestly, it's just a convience for you to not need to regenerate temporary Hypixel API keys constantly
4. You don't use this to split usage of an API key between unreleated apps or unrelated persons, selling access to an API key in any way is strictly forbidden by Hypixel

## How to use

This is intended to be a drop-in replacement for how you normally call the Hypixel API.

If you have a config like:
```conf
HYPIXEL_API_URL="https://api.hypixel.net"
HYPIXEL_API_KEY="your-secret-key-here"
```
You can replace it with:
```conf
HYPIXEL_API_URL="https://yourdomain.example" # The domain you have for this
HYPIXEL_API_KEY="your-unique-secret-key-that-doesnt-match-hypixel-here"
```

Endpoints that don't require an API key on Hypixel also work without one through the proxy. Those
requests are passed through without either a contributor key or the server-side Hypixel key.

## Configuration

Copy `contributors.example.toml` to the ignored `contributors.toml` file:

```toml
[contributors.alice]
key = "a-uuid-or-another-random-token-at-least-32-characters"
ipWhitelist = ["203.0.113.7/32", "2001:db8::/64"]
requestsPerMinute = 30

[contributors.bob]
key = "another-random-token-at-least-32-characters"
```

Use unique tokens for every contributor, this can be a random UUID or a more secure generation.

- `key` is required, it's the API key contributors will use
- `ipWhitelist` is optional and accepts exact IPv4/IPv6 addresses or CIDR ranges.
- `requestsPerMinute` is optional and exists as a safegaurd on leaked keys.

Configuration is loaded once at startup. Change or revoke a contributor by editing the mounted file
and restarting the container.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `HYPIXEL_API_KEY` | required | The actual Hypixel API key for your registered Hypixel application. |
| `AUTH_CONFIG_PATH` | `./contributors.toml` | Contributor TOML file. |
| `FORWARDED_FOR_HEADER` | unset | Trusted header containing exactly one client IP (if behind Cloudflare, use `CF-Connecting-IP`) |
| `UPSTREAM_TIMEOUT_MS` | `30000` | Overall upstream timeout in milliseconds. |
| `UPSTREAM_USER_AGENT` | unset | Override for the `User-Agent` sent to Hypixel. |
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port. |

## Docker

This is ideally used in Docker, the prebuilt image is:

`ghcr.io/ptlthg/hypixelproxy:latest`

The container listens on port `3000` and needs two things:

1. Your real Hypixel API key in the `HYPIXEL_API_KEY` environment variable
2. Your `contributors.toml` file mounted inside the container

### Docker Compose

The included `compose.yaml` is the easiest way to run it yourself:

```sh
cp .env.example .env
cp contributors.example.toml contributors.toml
docker compose up -d
```

Put the real Hypixel API key in `.env` and configure your contributors before starting it.

The Compose file mounts `contributors.toml` read-only at
`/run/secrets/contributors.toml` and defaults to port `3000`
