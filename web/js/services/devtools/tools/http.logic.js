// HTTP reference data (status codes + headers) and the "explain this response" analyser. Pure — no DOM.

/* ------------------------------------------------------------------ status codes */
// [code, name, explanation, typical causes, what to check, nonStandard?]
const S = [
  [100, 'Continue', 'The server got the request headers and the client may send the body.', 'Client sent "Expect: 100-continue" before a large upload.', 'Usually invisible; if uploads stall, check proxies that do not forward 100 responses.'],
  [101, 'Switching Protocols', 'The server agrees to switch protocol as asked in the Upgrade header.', 'WebSocket handshake (Upgrade: websocket), h2c upgrade.', 'For WebSockets behind a proxy, make sure it forwards Upgrade and Connection headers.'],
  [102, 'Processing', 'WebDAV: the server accepted the request and is still working on it.', 'Long WebDAV operations.', 'Deprecated in practice; rarely seen outside WebDAV.'],
  [103, 'Early Hints', 'Interim response with Link headers so the browser can preload resources before the final response.', 'CDN or server sending preload/preconnect hints.', 'Only Link headers matter here; the real status follows. Check the final response, not this one.'],
  [200, 'OK', 'The request succeeded; the body holds the result.', 'Normal success.', 'For APIs, a 200 with an error payload is a smell — check the body.'],
  [201, 'Created', 'A new resource was created.', 'POST/PUT that creates something.', 'The Location header should point at the new resource.'],
  [202, 'Accepted', 'Request accepted for processing, but not done yet.', 'Async jobs, queues.', 'Look for a status URL (Location / body) to poll.'],
  [203, 'Non-Authoritative Information', 'Success, but a transforming proxy modified the payload.', 'Proxies rewriting content.', 'Compare with the origin response if data looks off.'],
  [204, 'No Content', 'Success with no body.', 'DELETE, PUT, CORS preflight responses.', 'Clients must not try to parse a body; a Content-Length > 0 here is a bug.'],
  [205, 'Reset Content', 'Success; the client should reset the form/view.', 'Rare; form submissions.', 'Must not have a body.'],
  [206, 'Partial Content', 'Only the requested byte range is returned.', 'Range requests: video seeking, resumed downloads.', 'Check Content-Range and that the server honours If-Range.'],
  [207, 'Multi-Status', 'WebDAV: body (XML) holds a status per sub-resource.', 'WebDAV PROPFIND, batch operations.', 'Parse each inner status — the outer 207 says nothing about success.'],
  [208, 'Already Reported', 'WebDAV: members of a binding were already listed in this response.', 'WebDAV with bindings (avoids loops).', 'Only inside a 207 body.'],
  [226, 'IM Used', 'Delta encoding: the response is the result of instance manipulations on the current instance.', 'RFC 3229 delta encoding (rare).', 'Check the IM header.'],
  [300, 'Multiple Choices', 'Several representations exist; the client should choose.', 'Content negotiation without a default.', 'Rare; most servers pick one themselves.'],
  [301, 'Moved Permanently', 'The resource has a new permanent URL (Location). Clients may change POST to GET.', 'Domain move, http → https, trailing-slash rules.', 'Browsers cache 301s hard; use 308 to keep the method; check redirect loops.'],
  [302, 'Found', 'Temporary redirect to Location. Clients usually change POST to GET.', 'Login redirects, temporary moves.', 'Use 307 if the method/body must be kept.'],
  [303, 'See Other', 'Go GET the result at Location.', 'Post/Redirect/Get after a form submit.', 'Always becomes a GET.'],
  [304, 'Not Modified', 'The cached copy is still valid; no body.', 'Conditional GET with If-None-Match / If-Modified-Since.', 'If content looks stale, check ETag/Last-Modified generation and Cache-Control.'],
  [305, 'Use Proxy', 'Deprecated: access the resource through the given proxy.', 'Legacy.', 'Ignored by modern clients for security reasons.'],
  [307, 'Temporary Redirect', 'Temporary redirect that keeps the method and body.', 'HSTS internal redirects in browsers, maintenance moves.', 'Browsers show "307 Internal Redirect" for HSTS upgrades — that one never hit the network.'],
  [308, 'Permanent Redirect', 'Permanent redirect that keeps the method and body.', 'API moved permanently; POST endpoints relocated.', 'Cached like 301; check old clients that do not support 308.'],
  [400, 'Bad Request', 'The server cannot process the request because it is malformed.', 'Invalid JSON, missing fields, bad query params, oversized cookies (some servers).', 'Read the error body; validate Content-Type matches the body; check encoding of query strings.'],
  [401, 'Unauthorized', 'Authentication is missing or invalid (really "unauthenticated").', 'Missing/expired token, wrong scheme (Bearer vs Basic), clock skew on JWT.', 'Check the WWW-Authenticate header, token expiry (exp), and that the Authorization header survives proxies/redirects.'],
  [402, 'Payment Required', 'Reserved; some APIs use it for billing/quota problems.', 'Unpaid plan, exhausted credits.', 'See the API provider docs.'],
  [403, 'Forbidden', 'Authenticated (or not needed) but not allowed.', 'Missing role/scope, IP allow-list, WAF block, S3 bucket policy, CSRF failure.', 'Check permissions/scopes, WAF logs, S3 policies; a 403 on a missing S3 key means no ListBucket permission.'],
  [404, 'Not Found', 'No resource at this URL (or the server hides that it exists).', 'Typo, wrong base path/prefix behind a proxy, deleted item, missing trailing slash.', 'Check the exact path the server received (proxy rewrites), API version prefix, and route registration.'],
  [405, 'Method Not Allowed', 'The URL exists but not for this method.', 'POST to a GET-only route, missing OPTIONS handler for CORS.', 'The Allow header lists the methods that work.'],
  [406, 'Not Acceptable', 'No representation matches the Accept headers.', 'Strict Accept / Accept-Language negotiation.', 'Loosen Accept (e.g. */*).'],
  [407, 'Proxy Authentication Required', 'A proxy needs credentials first.', 'Corporate proxy.', 'Check Proxy-Authenticate and proxy credentials / HTTPS_PROXY env.'],
  [408, 'Request Timeout', 'The server gave up waiting for the client to send the request.', 'Slow uploads, idle keep-alive connections.', 'Check client upload speed and server/proxy read timeouts.'],
  [409, 'Conflict', 'The request conflicts with the current state of the resource.', 'Duplicate key, edit conflict, version mismatch.', 'Re-fetch the resource and retry; read the error body.'],
  [410, 'Gone', 'The resource is permanently gone.', 'Deleted content, retired API versions.', 'Remove links/clients pointing at it.'],
  [411, 'Length Required', 'The server needs a Content-Length header.', 'Chunked upload to a server that does not accept it.', 'Send Content-Length (buffer the body).'],
  [412, 'Precondition Failed', 'A conditional header (If-Match, If-Unmodified-Since) did not match.', 'Optimistic locking with stale ETag.', 'Re-fetch to get the current ETag.'],
  [413, 'Content Too Large', 'The body is larger than the server allows.', 'nginx client_max_body_size, API gateway limits, big uploads.', 'Check proxy body-size limits (nginx default is 1 MB).'],
  [414, 'URI Too Long', 'The URL is longer than the server accepts.', 'Huge query strings, redirect loops appending params.', 'Move data into a POST body.'],
  [415, 'Unsupported Media Type', 'The body format (Content-Type) is not supported.', 'Sending JSON without Content-Type: application/json, form instead of JSON.', 'Set the right Content-Type; check Content-Encoding.'],
  [416, 'Range Not Satisfiable', 'The requested range is outside the resource.', 'Resuming a download of a file that changed or is shorter.', 'Check Content-Range: bytes */<size> in the response.'],
  [417, 'Expectation Failed', 'The server cannot meet the Expect header.', 'Expect: 100-continue to a server/proxy that rejects it.', 'Remove Expect (curl: -H "Expect:").'],
  [418, "I'm a teapot", 'Joke code from RFC 2324; reserved, not a real status.', 'Easter eggs, some bot blockers.', 'Treat as a refusal; it is not part of HTTP semantics.', 'joke / reserved'],
  [421, 'Misdirected Request', 'The request went to a server that cannot answer for this host.', 'HTTP/2 connection reuse across hosts with different certificates, SNI/Host mismatch.', 'Check SNI vs Host header and certificate SANs on shared connections.'],
  [422, 'Unprocessable Content', 'The body is well-formed but semantically invalid.', 'Validation errors (FastAPI, Rails).', 'Read the validation details in the body.'],
  [423, 'Locked', 'WebDAV: the resource is locked.', 'WebDAV locks.', 'Find who holds the lock.'],
  [424, 'Failed Dependency', 'WebDAV: failed because a previous request failed.', 'Batch operations.', 'Fix the earlier failing request.'],
  [425, 'Too Early', 'The server will not process a request that might be replayed (TLS early data).', 'TLS 1.3 0-RTT requests.', 'Retry without early data.'],
  [426, 'Upgrade Required', 'The client must switch protocol (see Upgrade header).', 'Server requires TLS or a newer HTTP version.', 'Check the Upgrade header.'],
  [428, 'Precondition Required', 'The server requires a conditional request.', 'APIs enforcing optimistic locking (If-Match).', 'Send If-Match with the current ETag.'],
  [429, 'Too Many Requests', 'Rate limit hit.', 'Too many calls per time window, bursts, shared IP.', 'Honour Retry-After; check RateLimit-* / X-RateLimit-* headers; add backoff.'],
  [431, 'Request Header Fields Too Large', 'Headers (or one header) too big.', 'Huge cookies, giant JWTs, accumulated cookies on localhost.', 'Clear cookies for the domain; check proxy header buffer sizes.'],
  [451, 'Unavailable For Legal Reasons', 'Blocked for legal reasons.', 'Geo-blocking, court orders.', 'A Link rel="blocked-by" may name the authority.'],
  [499, 'Client Closed Request', 'nginx: the client closed the connection before the server answered.', 'Client timeout shorter than server processing, user navigated away.', 'Compare client timeouts with upstream latency; look for slow upstreams.', 'nginx'],
  [500, 'Internal Server Error', 'Generic server-side failure.', 'Unhandled exception, misconfiguration.', 'Server logs / stack trace; correlate with a request ID.'],
  [501, 'Not Implemented', 'The server does not support the method/feature.', 'Unknown method, unimplemented endpoint.', 'Check the method and API version.'],
  [502, 'Bad Gateway', 'A proxy got an invalid response from the upstream.', 'Upstream crashed/restarting, wrong upstream port, upstream closed connection, TLS mismatch.', 'Is the upstream running and listening on the configured port? Check proxy error log and keep-alive timeouts.'],
  [503, 'Service Unavailable', 'The server is temporarily unable to handle the request.', 'Overload, maintenance, no healthy backends, K8s pods not ready.', 'Check Retry-After, health checks, readiness probes, autoscaling.'],
  [504, 'Gateway Timeout', 'A proxy did not get a response from the upstream in time.', 'Slow query/upstream, proxy timeout too low, network/firewall drops.', 'Compare proxy timeout (e.g. proxy_read_timeout, ALB idle timeout) with upstream latency.'],
  [505, 'HTTP Version Not Supported', 'The HTTP version is not supported.', 'Old servers, broken clients.', 'Try HTTP/1.1.'],
  [506, 'Variant Also Negotiates', 'Content negotiation misconfiguration on the server (circular reference).', 'Server config error.', 'Fix the server negotiation config.'],
  [507, 'Insufficient Storage', 'WebDAV: server cannot store what is needed to complete the request.', 'Disk full, quota exceeded.', 'Check server disk / quota.'],
  [508, 'Loop Detected', 'WebDAV: infinite loop while processing (Depth: infinity).', 'Bindings forming cycles.', 'Check resource bindings.'],
  [510, 'Not Extended', 'Further extensions to the request are required (RFC 2774, obsolete).', 'Rare.', 'Historic; rarely used.'],
  [511, 'Network Authentication Required', 'The network (captive portal) requires login.', 'Hotel/airport Wi-Fi, captive portals.', 'Open a browser and log into the network.'],
  [520, 'Web Server Returned an Unknown Error', 'Cloudflare: the origin returned an empty/unknown response.', 'Origin crashed, reset connection, headers too large.', 'Check origin logs; test the origin directly bypassing Cloudflare.', 'Cloudflare'],
  [521, 'Web Server Is Down', 'Cloudflare: the origin refused the connection.', 'Origin down, firewall blocking Cloudflare IPs.', 'Allow Cloudflare IP ranges; make sure the origin listens.', 'Cloudflare'],
  [522, 'Connection Timed Out', 'Cloudflare: TCP connection to origin timed out.', 'Origin overloaded, firewall dropping packets.', 'Check origin load, firewall, and routing.', 'Cloudflare'],
  [523, 'Origin Is Unreachable', 'Cloudflare: could not reach the origin (DNS/routing).', 'Wrong DNS record, routing problem.', 'Check the DNS A/AAAA record of the origin.', 'Cloudflare'],
  [524, 'A Timeout Occurred', 'Cloudflare: connected but the origin did not answer within 100 s.', 'Long-running requests.', 'Make the endpoint async (202 + polling) or speed it up.', 'Cloudflare'],
];

export const STATUS = S.map(([code, name, desc, causes, check, nonStandard]) => ({
  type: 'status', code, name, cls: `${String(code)[0]}xx`, desc, causes, check, nonStandard: nonStandard || null,
}));

/* ------------------------------------------------------------------ headers */
// [name, kind (request|response|both), tags, description, example, gotchas]
const H = [
  // caching
  ['Cache-Control', 'both', ['caching'], 'Caching directives for browsers and shared caches (max-age, no-cache, no-store, private, public, s-maxage, immutable, must-revalidate).', 'Cache-Control: public, max-age=31536000, immutable', 'no-cache means "revalidate before use", not "do not cache" — that is no-store. no-store overrides everything else.'],
  ['Expires', 'response', ['caching'], 'Absolute date after which the response is stale (HTTP/1.0).', 'Expires: Wed, 21 Oct 2026 07:28:00 GMT', 'Ignored when Cache-Control max-age is present. Depends on clocks being right.'],
  ['ETag', 'response', ['caching'], 'Opaque version identifier of the representation, used for revalidation and optimistic locking.', 'ETag: "33a64df551425fcc"', 'W/ prefix = weak validator. Load-balanced servers must produce the same ETag or caching breaks. Compression may change it.'],
  ['Last-Modified', 'response', ['caching'], 'When the resource last changed; used with If-Modified-Since.', 'Last-Modified: Tue, 15 Oct 2026 12:45:26 GMT', 'Only 1-second resolution; prefer ETag for frequently changing data.'],
  ['If-None-Match', 'request', ['caching'], 'Conditional request: send the body only if the ETag differs (else 304).', 'If-None-Match: "33a64df551425fcc"', 'Weak comparison is used; * matches any existing representation.'],
  ['If-Modified-Since', 'request', ['caching'], 'Conditional request: send the body only if changed since this date (else 304).', 'If-Modified-Since: Tue, 15 Oct 2026 12:45:26 GMT', 'Ignored when If-None-Match is present.'],
  ['If-Match', 'request', ['caching'], 'Only perform the request if the current ETag matches (optimistic locking).', 'If-Match: "33a64df551425fcc"', 'Mismatch → 412 Precondition Failed. Uses strong comparison.'],
  ['If-Unmodified-Since', 'request', ['caching'], 'Only perform the request if not modified since this date.', 'If-Unmodified-Since: Tue, 15 Oct 2026 12:45:26 GMT', 'Mismatch → 412.'],
  ['Age', 'response', ['caching'], 'Seconds the response has been in a shared cache.', 'Age: 120', 'A non-zero Age means you are seeing a cached copy (CDN).'],
  ['Vary', 'response', ['caching'], 'Request headers that select between representations; caches key on them.', 'Vary: Accept-Encoding, Origin', 'Vary: * effectively disables caching. CORS responses that depend on Origin must include Vary: Origin.'],
  ['Pragma', 'both', ['caching'], 'Legacy HTTP/1.0 cache directive (no-cache).', 'Pragma: no-cache', 'Deprecated; use Cache-Control. Has no defined meaning on responses.'],
  // CORS
  ['Origin', 'request', ['cors'], 'Scheme + host + port of the page making the request; sent with CORS and POST requests.', 'Origin: https://app.example.com', 'Can be "null" (sandboxed iframes, file://, some redirects). Do not allow-list "null".'],
  ['Access-Control-Allow-Origin', 'response', ['cors'], 'Which origin may read the response: one origin or *.', 'Access-Control-Allow-Origin: https://app.example.com', 'Only one origin allowed — echo the request Origin after checking an allow-list and add Vary: Origin. * cannot be used with credentials.'],
  ['Access-Control-Allow-Credentials', 'response', ['cors'], 'Allows cookies/Authorization on cross-origin requests when true.', 'Access-Control-Allow-Credentials: true', 'Requires a specific origin (not *). Client must also use credentials: "include" / withCredentials.'],
  ['Access-Control-Allow-Methods', 'response', ['cors'], 'Methods allowed in a preflight response.', 'Access-Control-Allow-Methods: GET, POST, PUT, DELETE', 'Only relevant on the OPTIONS preflight response.'],
  ['Access-Control-Allow-Headers', 'response', ['cors'], 'Request headers allowed in a preflight response.', 'Access-Control-Allow-Headers: Authorization, Content-Type', 'Content-Type: application/json is not "simple" and must be listed. * does not cover Authorization.'],
  ['Access-Control-Expose-Headers', 'response', ['cors'], 'Response headers that browser JS may read beyond the safe list.', 'Access-Control-Expose-Headers: X-Request-ID, Content-Disposition', 'Without it, JS cannot read custom headers even though DevTools shows them.'],
  ['Access-Control-Max-Age', 'response', ['cors'], 'How long (seconds) a preflight result may be cached.', 'Access-Control-Max-Age: 600', 'Browsers cap it (Chrome: 2 h, Firefox: 24 h).'],
  ['Access-Control-Request-Method', 'request', ['cors'], 'Preflight: the method the real request will use.', 'Access-Control-Request-Method: PUT', 'Sent by the browser automatically.'],
  ['Access-Control-Request-Headers', 'request', ['cors'], 'Preflight: non-simple headers the real request will send.', 'Access-Control-Request-Headers: authorization, content-type', 'Sent by the browser automatically; server must echo/allow them.'],
  // auth
  ['Authorization', 'request', ['auth'], 'Credentials for the target server (Basic, Bearer, Digest, AWS4-HMAC-SHA256…).', 'Authorization: Bearer eyJhbGciOi…', 'Contains secrets — never log or paste it. Dropped by most clients on cross-host redirects.'],
  ['WWW-Authenticate', 'response', ['auth'], 'Sent with 401: which auth scheme(s) the server accepts and why it failed.', 'WWW-Authenticate: Bearer error="invalid_token", error_description="expired"', 'A "Basic" challenge makes browsers pop up a login dialog.'],
  ['Proxy-Authorization', 'request', ['auth', 'proxy'], 'Credentials for an intermediate proxy.', 'Proxy-Authorization: Basic dXNlcjpwYXNz', 'Contains secrets. Basic is only base64, not encryption.'],
  ['Proxy-Authenticate', 'response', ['auth', 'proxy'], 'Sent with 407: how to authenticate to the proxy.', 'Proxy-Authenticate: Basic realm="corp"', ''],
  // content negotiation
  ['Accept', 'request', ['negotiation'], 'Media types the client can handle, with q-weights.', 'Accept: application/json, text/plain;q=0.5', 'A missing/odd Accept can make servers return HTML error pages instead of JSON.'],
  ['Accept-Encoding', 'request', ['negotiation', 'compression'], 'Compression algorithms the client supports.', 'Accept-Encoding: gzip, deflate, br, zstd', 'curl only decompresses with --compressed; otherwise you get binary output.'],
  ['Accept-Language', 'request', ['negotiation'], 'Preferred languages.', 'Accept-Language: en-GB,en;q=0.9', 'Responses that vary by it need Vary: Accept-Language.'],
  ['Content-Type', 'both', ['negotiation'], 'Media type of the body (and charset/boundary).', 'Content-Type: application/json; charset=utf-8', 'multipart/form-data needs the boundary param — let the client set it. Wrong type → 415 or empty parsed body.'],
  ['Content-Encoding', 'both', ['compression'], 'Compression applied to the body (gzip, br, zstd).', 'Content-Encoding: gzip', 'Content-Length refers to the compressed size. Double compression by proxy + app breaks clients.'],
  ['Content-Language', 'response', ['negotiation'], 'Language of the content.', 'Content-Language: de-DE', ''],
  ['Content-Length', 'both', ['negotiation'], 'Body size in bytes.', 'Content-Length: 348', 'Must match the bytes sent; a mismatch causes hangs or truncation. Not used with chunked transfer.'],
  ['Content-Disposition', 'response', ['negotiation'], 'inline or attachment (download) plus the file name.', 'Content-Disposition: attachment; filename="report.csv"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.csv', 'Use filename* for non-ASCII names. Needs Access-Control-Expose-Headers for JS to read it cross-origin.'],
  ['Transfer-Encoding', 'both', ['negotiation'], 'Hop-by-hop transfer coding, normally chunked.', 'Transfer-Encoding: chunked', 'Not used in HTTP/2. Conflicting Content-Length + Transfer-Encoding enables request smuggling.'],
  // security
  ['Content-Security-Policy', 'response', ['security'], 'Restricts where scripts, styles, frames etc. may load from; main defence against XSS.', "Content-Security-Policy: default-src 'self'; script-src 'self'; frame-ancestors 'none'", "'unsafe-inline' / 'unsafe-eval' largely defeat it. frame-ancestors replaces X-Frame-Options. Test with Report-Only first."],
  ['Content-Security-Policy-Report-Only', 'response', ['security'], 'Same as CSP but only reports violations.', "Content-Security-Policy-Report-Only: default-src 'self'; report-to csp", 'Does not protect anything on its own.'],
  ['Strict-Transport-Security', 'response', ['security'], 'HSTS: browser uses HTTPS only for this host for max-age seconds.', 'Strict-Transport-Security: max-age=63072000; includeSubDomains; preload', 'Ignored over plain HTTP. includeSubDomains/preload can break http-only subdomains; preload is hard to undo.'],
  ['X-Content-Type-Options', 'response', ['security'], 'nosniff: stop browsers guessing (sniffing) the content type.', 'X-Content-Type-Options: nosniff', 'Then Content-Type must be correct (scripts need a JS MIME type).'],
  ['X-Frame-Options', 'response', ['security'], 'Clickjacking protection: DENY or SAMEORIGIN.', 'X-Frame-Options: DENY', 'Legacy; CSP frame-ancestors takes precedence. ALLOW-FROM is not supported.'],
  ['Referrer-Policy', 'response', ['security'], 'How much of the URL is sent in Referer.', 'Referrer-Policy: strict-origin-when-cross-origin', 'unsafe-url leaks full URLs (tokens in query strings) to third parties.'],
  ['Permissions-Policy', 'response', ['security'], 'Enables/disables browser features (camera, geolocation…) for the page and iframes.', 'Permissions-Policy: camera=(), geolocation=(self), microphone=()', 'Replaces Feature-Policy; syntax differs (structured fields).'],
  ['Cross-Origin-Opener-Policy', 'response', ['security'], 'COOP: isolates the browsing context from cross-origin popups.', 'Cross-Origin-Opener-Policy: same-origin', 'Can break OAuth popups that rely on window.opener.'],
  ['Cross-Origin-Embedder-Policy', 'response', ['security'], 'COEP: only load cross-origin resources that opt in (needed for SharedArrayBuffer).', 'Cross-Origin-Embedder-Policy: require-corp', 'Third-party images/scripts without CORP/CORS will fail to load.'],
  ['Cross-Origin-Resource-Policy', 'response', ['security'], 'CORP: who may embed this resource (same-site, same-origin, cross-origin).', 'Cross-Origin-Resource-Policy: same-origin', ''],
  ['X-XSS-Protection', 'response', ['security'], 'Legacy XSS filter switch for old browsers.', 'X-XSS-Protection: 0', 'Deprecated; modern advice is 0 (or omit) and use CSP. "1; mode=block" could introduce leaks.'],
  // cookies
  ['Cookie', 'request', ['cookies'], 'Cookies the browser sends for this host/path.', 'Cookie: session=abc123; theme=dark', 'Contains secrets (session IDs). Cannot be set from browser fetch().'],
  ['Set-Cookie', 'response', ['cookies'], 'Stores a cookie (with Expires/Max-Age, Path, Domain, Secure, HttpOnly, SameSite).', 'Set-Cookie: session=abc123; Path=/; Secure; HttpOnly; SameSite=Lax', 'SameSite=None requires Secure. One header per cookie (never comma-joined). Not readable by JS fetch.'],
  // range
  ['Range', 'request', ['range'], 'Request only part of the resource.', 'Range: bytes=0-1023', 'Server answers 206 or 200 (ignoring), or 416 if out of range.'],
  ['Accept-Ranges', 'response', ['range'], 'Whether the server supports range requests.', 'Accept-Ranges: bytes', '"none" disables resume/seek.'],
  ['Content-Range', 'response', ['range'], 'Which part of the resource the 206 body contains.', 'Content-Range: bytes 0-1023/146515', 'On 416: bytes */146515.'],
  ['If-Range', 'request', ['range', 'caching'], 'Send the range only if the resource is unchanged (ETag/date), else the full body.', 'If-Range: "33a64df551425fcc"', 'Prevents stitching parts of different file versions.'],
  // proxies / forwarding
  ['Forwarded', 'request', ['proxy'], 'Standard (RFC 7239) way proxies record the original client, host and protocol.', 'Forwarded: for=203.0.113.7;proto=https;host=example.com', 'Can be spoofed by clients — only trust values added by your own proxies.'],
  ['X-Forwarded-For', 'request', ['proxy'], 'Chain of client IPs added by proxies.', 'X-Forwarded-For: 203.0.113.7, 10.0.0.2', 'Left-most can be forged; take the IP added by your trusted proxy (count from the right).'],
  ['X-Forwarded-Proto', 'request', ['proxy'], 'Original protocol (http/https) before TLS termination.', 'X-Forwarded-Proto: https', 'Apps that ignore it generate http:// redirects → redirect loops behind load balancers.'],
  ['X-Forwarded-Host', 'request', ['proxy'], 'Original Host requested by the client.', 'X-Forwarded-Host: example.com', 'Trusting it blindly enables host-header injection (password reset links).'],
  ['X-Real-IP', 'request', ['proxy'], 'nginx convention: the single client IP.', 'X-Real-IP: 203.0.113.7', 'Same trust issues as X-Forwarded-For.'],
  ['Via', 'both', ['proxy'], 'Proxies the message passed through.', 'Via: 1.1 varnish, 1.1 cloudfront', 'Handy for spotting CDNs/caches in the path.'],
  // general
  ['Host', 'request', ['general'], 'Target host (and port); required in HTTP/1.1. HTTP/2 uses :authority.', 'Host: api.example.com', 'Wrong Host → wrong virtual host / 404 / 421. Used for SNI routing.'],
  ['User-Agent', 'request', ['general'], 'Identifies the client software.', 'User-Agent: curl/8.5.0', 'Some WAFs block default curl/python UAs.'],
  ['Referer', 'request', ['general'], 'URL of the page that linked here (misspelled in the spec).', 'Referer: https://example.com/page', 'Controlled by Referrer-Policy; may leak query-string tokens.'],
  ['Location', 'response', ['general'], 'Redirect target (3xx) or the new resource (201).', 'Location: /users/42', 'May be relative. http:// Location behind TLS termination → check X-Forwarded-Proto handling.'],
  ['Retry-After', 'response', ['general'], 'When to retry after 429/503 (seconds or a date).', 'Retry-After: 120', 'Respect it in clients to avoid bans.'],
  ['Connection', 'both', ['general'], 'Hop-by-hop options (keep-alive, close, upgrade).', 'Connection: keep-alive', 'Forbidden in HTTP/2; proxies strip it.'],
  ['Keep-Alive', 'response', ['general'], 'Keep-alive parameters (timeout, max).', 'Keep-Alive: timeout=5, max=1000', 'Proxy keep-alive timeouts longer than the upstream\'s cause random 502s.'],
  ['Upgrade', 'both', ['general'], 'Ask to switch protocol (WebSocket, h2c).', 'Upgrade: websocket', 'Proxies must forward it explicitly (nginx: proxy_set_header Upgrade $http_upgrade).'],
  ['Server', 'response', ['general', 'security'], 'Server software name/version.', 'Server: nginx', 'Version numbers help attackers — hide them (server_tokens off).'],
  ['X-Powered-By', 'response', ['general', 'security'], 'Framework that generated the response.', 'X-Powered-By: Express', 'Information disclosure — usually disable it.'],
  ['Date', 'response', ['general'], 'When the response was generated.', 'Date: Wed, 05 Nov 2026 10:00:00 GMT', 'Clock skew between servers breaks caching and signed requests.'],
  ['Allow', 'response', ['general'], 'Methods supported by the resource (with 405 / OPTIONS).', 'Allow: GET, HEAD, OPTIONS', ''],
  ['Link', 'response', ['general'], 'Typed links: pagination (rel=next), preload, canonical.', 'Link: <https://api.example.com/items?page=2>; rel="next"', 'GitHub-style pagination lives here, not in the body.'],
  ['X-Request-ID', 'both', ['general'], 'Correlation ID to trace a request through services and logs.', 'X-Request-ID: 7f3c2a8e-…', 'Include it when reporting errors.'],
  ['Expect', 'request', ['general'], 'Expect: 100-continue — ask before sending a large body.', 'Expect: 100-continue', 'curl sends it for bodies > 1 MB; some servers mishandle it (417 / 1 s delays).'],
  ['Alt-Svc', 'response', ['general'], 'Advertises alternative protocols/endpoints (e.g. HTTP/3).', 'Alt-Svc: h3=":443"; ma=86400', ''],
];

export const HEADERS = H.map(([name, kind, tags, desc, example, gotchas]) => ({ type: 'header', name, kind, tags, desc, example, gotchas }));

const HEADER_INDEX = new Map(HEADERS.map((x) => [x.name.toLowerCase(), x]));
export const findHeader = (name) => HEADER_INDEX.get(String(name).trim().toLowerCase()) || null;
export const findStatus = (code) => STATUS.find((s) => s.code === Number(code)) || null;

export const FILTERS = [
  ['all', 'All'], ['1xx', '1xx'], ['2xx', '2xx'], ['3xx', '3xx'], ['4xx', '4xx'], ['5xx', '5xx'],
  ['request', 'Request headers'], ['response', 'Response headers'], ['security', 'Security'], ['cors', 'CORS'], ['caching', 'Caching'],
];

function matchesFilter(entry, filter) {
  if (!filter || filter === 'all') return true;
  if (/^\dxx$/.test(filter)) return entry.type === 'status' && entry.cls === filter;
  if (entry.type !== 'header') return false;
  if (filter === 'request' || filter === 'response') return entry.kind === filter || entry.kind === 'both';
  return entry.tags.includes(filter);
}

/** Search both tables. Query matches code (prefix, "4" or "40x" style), name, or any text field. */
export function searchReference(query = '', filter = 'all') {
  const q = String(query).trim().toLowerCase();
  const all = [...STATUS, ...HEADERS].filter((e) => matchesFilter(e, filter));
  if (!q) return all;
  const codeLike = /^[1-5x]{1,3}$/.test(q) ? new RegExp(`^${q.replace(/x/g, '\\d')}`) : null;
  const scored = [];
  for (const e of all) {
    let score = 0;
    if (e.type === 'status') {
      const c = String(e.code);
      if (c === q) score = 100;
      else if (codeLike && codeLike.test(c)) score = 80;
    }
    const name = e.name.toLowerCase();
    if (!score && name === q) score = 90;
    else if (!score && name.startsWith(q)) score = 70;
    else if (!score && name.includes(q)) score = 60;
    if (!score) {
      const text = [e.desc, e.causes, e.check, e.example, e.gotchas, e.nonStandard, ...(e.tags || [])].filter(Boolean).join(' ').toLowerCase();
      if (q.split(/\s+/).every((w) => text.includes(w) || name.includes(w))) score = 10;
    }
    if (score) scored.push([score, e]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(([, e]) => e);
}

/* ------------------------------------------------------------------ explain a response */
/** Raw header block → {statusLine, status, headers:[{name, value}]}. Accepts "HTTP/1.1 200 OK" / "HTTP/2 200" and DevTools-style lines. */
export function parseRawHeaders(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  let status = null, statusLine = null;
  const headers = [];
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const sl = line.trim().match(/^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/i);
    if (sl) { status = Number(sl[1]); statusLine = line.trim(); headers.length = 0; bad.length = 0; continue; }  // keep the last response (after redirects / 100)
    if (/^\s/.test(line) && headers.length) { headers[headers.length - 1].value += ` ${line.trim()}`; continue; }  // obsolete folding
    const m = line.match(/^\s*(:?[^:\s][^:]*?)\s*:\s?(.*)$/);
    if (!m || /\s/.test(m[1])) { bad.push(line.trim()); continue; }
    if (m[1] === ':status') { status = Number(m[2]); continue; }
    if (m[1].startsWith(':')) continue;  // HTTP/2 pseudo headers
    headers.push({ name: m[1], value: m[2].trim() });
  }
  return { status, statusLine, headers, unparsed: bad };
}

const parseDirectives = (v) => Object.fromEntries(String(v).split(',').map((d) => d.trim()).filter(Boolean)
  .map((d) => { const [k, ...rest] = d.split('='); return [k.trim().toLowerCase(), rest.join('=').trim().replace(/^"|"$/g, '') || true]; }));

/** Header-specific one-line notes for a value. */
function noteFor(name, value, all) {
  const n = name.toLowerCase();
  const notes = [];
  if (n === 'cache-control') {
    const d = parseDirectives(value);
    if (d['no-store']) notes.push('Not stored by any cache.');
    else if (d['no-cache']) notes.push('Cached, but revalidated with the server before each use.');
    if (d['max-age'] !== undefined && !d['no-store']) notes.push(`Fresh for ${humanSeconds(Number(d['max-age']))}.`);
    if (d['s-maxage'] !== undefined) notes.push(`Shared caches (CDN): ${humanSeconds(Number(d['s-maxage']))}.`);
    if (d.private) notes.push('Only the browser may cache it, not CDNs.');
    if (d.immutable) notes.push('Browser will not revalidate while fresh.');
  } else if (n === 'strict-transport-security') {
    const d = parseDirectives(value.replace(/;/g, ','));
    if (d['max-age'] !== undefined) notes.push(`HTTPS-only for ${humanSeconds(Number(d['max-age']))}${d.includesubdomains ? ', including subdomains' : ''}.`);
  } else if (n === 'set-cookie') {
    const attrs = value.split(';').slice(1).map((a) => a.trim().toLowerCase());
    const cname = value.split('=')[0].trim();
    notes.push(`Cookie "${cname}": ${['secure', 'httponly'].filter((a) => attrs.includes(a)).join(', ') || 'no Secure/HttpOnly'}${attrs.find((a) => a.startsWith('samesite')) ? `, ${attrs.find((a) => a.startsWith('samesite'))}` : ''}.`);
  } else if (n === 'content-type' && /^text\/|json|javascript|xml/i.test(value) && !/charset/i.test(value) && !/json/i.test(value)) {
    notes.push('No charset — browsers may guess the encoding.');
  } else if (n === 'access-control-allow-origin') {
    notes.push(value.trim() === '*' ? 'Any origin may read this response (without credentials).' : `Only ${value.trim()} may read this response.`);
  } else if (n === 'age' && Number(value) > 0) {
    notes.push(`Served from a shared cache, ${humanSeconds(Number(value))} old.`);
  } else if (n === 'retry-after' && /^\d+$/.test(value.trim())) {
    notes.push(`Retry in ${humanSeconds(Number(value))}.`);
  }
  void all;
  return notes;
}

export function humanSeconds(s) {
  if (!Number.isFinite(s)) return `${s} s`;
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  if (s < 63072000) return `${Math.round(s / 86400)} days`;
  return `${(s / 31536000).toFixed(1).replace(/\.0$/, '')} years`;
}

/**
 * Explain a pasted response header block.
 * → {status, statusInfo, headers:[{name, value, info, notes}], warnings:[{level:'warn'|'err'|'info', text}], unparsed}
 */
export function explainResponse(text) {
  const parsed = parseRawHeaders(text);
  const { headers } = parsed;
  const get = (n) => headers.filter((x) => x.name.toLowerCase() === n);
  const has = (n) => get(n).length > 0;
  const val = (n) => get(n).map((x) => x.value).join(', ');
  const warnings = [];
  const w = (level, t) => warnings.push({ level, text: t });

  const isHtml = /text\/html/i.test(val('content-type'));
  // security headers
  if (headers.length) {
    if (!has('strict-transport-security')) w('warn', 'No Strict-Transport-Security (HSTS) — add it if this is served over HTTPS.');
    if (!has('x-content-type-options')) w('warn', 'No X-Content-Type-Options: nosniff.');
    else if (val('x-content-type-options').toLowerCase().trim() !== 'nosniff') w('warn', 'X-Content-Type-Options should be exactly "nosniff".');
    if (isHtml || !has('content-type')) {
      if (!has('content-security-policy')) w('warn', `No Content-Security-Policy${has('content-security-policy-report-only') ? ' (only Report-Only, which does not enforce)' : ''}.`);
      if (!has('x-frame-options') && !/frame-ancestors/i.test(val('content-security-policy'))) w('warn', 'No clickjacking protection (CSP frame-ancestors or X-Frame-Options).');
      if (!has('referrer-policy')) w('info', 'No Referrer-Policy (browsers default to strict-origin-when-cross-origin).');
      if (!has('permissions-policy')) w('info', 'No Permissions-Policy.');
    }
    const csp = val('content-security-policy');
    if (/'unsafe-inline'/.test(csp) && /script-src|default-src/.test(csp)) w('warn', "CSP allows 'unsafe-inline' scripts, which weakens XSS protection.");
    if (/'unsafe-eval'/.test(csp)) w('warn', "CSP allows 'unsafe-eval'.");
    const hsts = val('strict-transport-security');
    if (hsts) {
      const m = hsts.match(/max-age\s*=\s*"?(\d+)/i);
      if (!m) w('err', 'HSTS without max-age is ignored.');
      else if (Number(m[1]) < 15552000 && Number(m[1]) > 0) w('info', `HSTS max-age is short (${humanSeconds(Number(m[1]))}); 6–12 months is common.`);
    }
    if (/\d/.test(val('server'))) w('info', `Server header reveals a version (${val('server')}).`);
    if (has('x-powered-by')) w('info', `X-Powered-By reveals the framework (${val('x-powered-by')}).`);
    if (/1/.test(val('x-xss-protection'))) w('info', 'X-XSS-Protection is deprecated; "0" (or omitting it) plus CSP is the current advice.');
  }
  // CORS
  const acao = get('access-control-allow-origin');
  const acac = val('access-control-allow-credentials').toLowerCase().trim() === 'true';
  if (acao.length > 1 || /,/.test(val('access-control-allow-origin'))) w('err', 'Access-Control-Allow-Origin has several values — browsers reject that; send exactly one origin.');
  if (acao.length && acao[0].value.trim() === '*' && acac) w('err', 'Access-Control-Allow-Origin: * together with Allow-Credentials: true — browsers block credentialed requests; echo a specific allow-listed origin instead.');
  if (acao.length && acao[0].value.trim() === 'null') w('err', 'Access-Control-Allow-Origin: null can be matched by sandboxed iframes and file:// pages.');
  if (acao.length && acao[0].value.trim() !== '*' && !/origin/i.test(val('vary'))) w('warn', 'A specific Access-Control-Allow-Origin without Vary: Origin — caches may serve it to other origins.');
  if (/\*/.test(val('access-control-allow-headers')) && acac) w('warn', 'Access-Control-Allow-Headers: * is treated literally when credentials are allowed.');
  // caching
  const cc = parseDirectives(val('cache-control'));
  if (cc['no-store'] && (cc['max-age'] !== undefined || cc.public || cc.immutable || cc['s-maxage'] !== undefined)) w('warn', 'Cache-Control mixes no-store with max-age/public/immutable — no-store wins, the rest is ignored.');
  if (cc['no-cache'] && cc.immutable) w('warn', 'Cache-Control has both no-cache and immutable — contradictory.');
  if (cc.public && cc.private) w('warn', 'Cache-Control has both public and private.');
  if (cc['max-age'] !== undefined && !/^\d+$/.test(String(cc['max-age']))) w('err', `Cache-Control max-age "${cc['max-age']}" is not a whole number of seconds.`);
  if (has('expires') && cc['max-age'] !== undefined) w('info', 'Both Expires and max-age are set — max-age wins.');
  if (has('pragma') && has('cache-control') && /no-cache/i.test(val('pragma')) && cc['max-age'] > 0) w('warn', 'Pragma: no-cache conflicts with a positive Cache-Control max-age (Pragma is ignored by modern caches).');
  if (/\*/.test(val('vary'))) w('warn', 'Vary: * makes the response effectively uncacheable.');
  if (has('set-cookie') && (cc.public || cc['s-maxage'] !== undefined)) w('err', 'A response that sets cookies is marked cacheable by shared caches (public / s-maxage) — a CDN could hand one user\'s cookie to others.');
  if (!has('cache-control') && !has('expires') && headers.length && (has('etag') || has('last-modified'))) w('info', 'No Cache-Control — browsers apply heuristic caching (≈10% of the time since Last-Modified).');
  // cookies
  for (const c of get('set-cookie')) {
    const attrs = c.value.split(';').slice(1).map((a) => a.trim().toLowerCase());
    const cname = c.value.split('=')[0].trim();
    const ss = attrs.find((a) => a.startsWith('samesite'));
    if (ss && /none/.test(ss) && !attrs.includes('secure')) w('err', `Cookie "${cname}": SameSite=None requires Secure — browsers reject it.`);
    if (!attrs.includes('secure')) w('warn', `Cookie "${cname}" lacks Secure.`);
    if (!attrs.includes('httponly') && /sess|token|auth|sid|jwt/i.test(cname)) w('warn', `Cookie "${cname}" looks like a session cookie but lacks HttpOnly (readable by JS).`);
    if (/^__(host|secure)-/i.test(cname) && !attrs.includes('secure')) w('err', `Cookie "${cname}" uses a __Host-/__Secure- prefix but is not Secure — it will be rejected.`);
  }
  // misc
  if (has('content-length') && has('transfer-encoding')) w('err', 'Both Content-Length and Transfer-Encoding — invalid, and a request-smuggling risk.');
  const ctypes = get('content-type');
  if (ctypes.length > 1) w('warn', 'Several Content-Type headers.');
  if (parsed.status && [301, 302, 303, 307, 308, 201].includes(parsed.status) && !has('location')) w('warn', `${parsed.status} without a Location header.`);
  if (/^http:\/\//i.test(val('location')) && has('strict-transport-security')) w('warn', 'Redirect Location uses http:// on an HSTS site — check X-Forwarded-Proto handling behind the proxy.');
  if ((parsed.status === 429 || parsed.status === 503) && !has('retry-after')) w('info', `${parsed.status} without Retry-After.`);
  if (parsed.status === 401 && !has('www-authenticate')) w('info', '401 without WWW-Authenticate (required by the spec).');
  const seen = new Map();
  for (const x of headers) { const k = x.name.toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
  for (const [k, n] of seen) if (n > 1 && !['set-cookie', 'vary', 'link', 'via', 'cache-control', 'access-control-allow-origin', 'content-type'].includes(k)) w('info', `"${k}" appears ${n} times.`);

  return {
    status: parsed.status,
    statusLine: parsed.statusLine,
    statusInfo: parsed.status ? findStatus(parsed.status) : null,
    headers: headers.map((x) => ({ ...x, info: findHeader(x.name), notes: noteFor(x.name, x.value, headers) })),
    warnings,
    unparsed: parsed.unparsed,
  };
}
