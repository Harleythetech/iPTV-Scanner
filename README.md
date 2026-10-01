# iPTV-Scanner

A practical M3U/M3U8 playlist validator for finding endpoints that respond, fail, require authentication, or look unlike a media stream.

This is a rebuild of the original `Harleythetech/iPTV-Scanner` project. The original was a small browser page with basic playlist input; this version separates playlist parsing from HTTP/HLS probing and adds an optional Node.js server so remote URLs can be tested without relying entirely on browser CORS behavior.

## Features

- Parse normal `#EXTM3U` playlists plus imperfect playlists containing bare URL lines.
- Preserve common `tvg-id`, `tvg-name`, `tvg-logo`, `group-title`, and duration metadata.
- Resolve relative stream URLs when the source playlist URL is known.
- Detect duplicate URLs and avoid probing the same endpoint twice.
- Probe with bounded reads instead of downloading a complete live stream.
- Retry network failures, timeouts, and selected transient HTTP responses.
- Classify common HTTP failures (`401`, `403`, `404`, `429`, `4xx`, `5xx`).
- Detect common HTML/JSON false positives returned by portals and APIs.
- Recognize HLS master/media playlists and optionally verify a child playlist and media resource.
- Check MPEG-TS, ISO-BMFF/MP4, WebM/Matroska, Ogg, ID3/MP3, FLAC, and MPEG-audio signatures when headers are weak.
- Preserve common VLC HTTP referrer/user-agent playlist directives so protected streams can be tested when the playlist supplies those hints.
- Distinguish CORS-opaque reachability from a confirmed media stream in browser mode.
- Validate HLS media resources instead of treating a responding child playlist as proof by itself.
- Probe with Range first and fall back to an ordinary GET for endpoints that reject Range requests.
- Filter results by status, group, or search term.
- Export online-looking entries as M3U and export complete results as CSV/JSON.
- Scan local files directly in the browser.
- Scan remote playlist URLs in server mode.
- Abort a long-running scan.
- Block private/reserved server-side destinations by default to reduce SSRF risk.

## Accuracy model

The scanner deliberately avoids treating every `200 OK` response as a working channel.

`Online` is deliberately strict: the scanner needs media evidence (recognized bytes or a trustworthy media content type) or a valid HLS chain that reaches an actual media resource. A live HLS manifest by itself is not enough.

`Responds` means the request succeeded and bytes were returned, but the scanner could not confidently establish that they are media. In browser static mode, a successful `no-cors` fallback is also reported as `Reachable (opaque)` because the browser hides the real HTTP status/body.

`Manifest only` means a valid HLS manifest was found but the scanner could not verify a real media resource beneath it. This is intentionally different from `Online`.

The scanner probes with a bounded HTTP GET and a byte range when possible, follows redirects itself, records the final URL, inspects the body rather than trusting status alone, retries selected transient failures, and can walk HLS master → media playlist → segment/resource chains. This mirrors the useful accuracy improvements in the browser-oriented implementation while keeping server-side probing stronger.

HTTP authentication, authorization, rate limiting, missing resources, server errors, timeouts, network failures, and unexpected HTML/JSON are reported separately. This gives a more useful diagnosis than a simple alive/dead flag.

No automated HTTP checker can guarantee playback on every device or player. DRM, session cookies, token expiration, geo restrictions, CDN behavior, player compatibility, and changes after the scan can still make a stream unplayable.

## Quick start

### Server mode

Requires Node.js 20+.

```bash
npm install
npm start
```

Open `http://localhost:4199`.

Development mode:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

### Static GitHub Pages mode

The root `index.html`, `app.js`, and `styles.css` can be served as a static site. Local playlist files work without a server.

Remote playlist and stream checks from a static site are subject to browser CORS rules. For dependable remote scanning, run the Node server or deploy the server component somewhere reachable by the browser.

## Server security

The scan API accepts user-supplied URLs, so server mode validates targets before requesting them. HTTP/HTTPS is required, embedded URL credentials are rejected, redirects are checked hop-by-hop, and private/reserved IP destinations are blocked by default.

For a trusted private network deployment only, you can opt in with:

```bash
ALLOW_PRIVATE_TARGETS=true npm start
```

Do not enable this on a public scanner instance.

## Repository layout

```text
.
├── index.html
├── app.js
├── styles.css
├── server.js
├── src/
│   ├── m3u.js
│   ├── scanner.js
│   └── security.js
├── test/
│   ├── integration.test.js
│   ├── m3u.test.js
│   └── scanner.test.js
├── sample/
│   └── example.m3u
├── package.json
└── package-lock.json
```

## Scope

Use the scanner with playlists and stream endpoints you are allowed to inspect. It validates availability and response characteristics; it does not attempt to bypass DRM, authentication, geo-blocking, or other access controls.
