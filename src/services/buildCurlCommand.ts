import type { HttpRequestTypeOptions } from '../shared/types';

/**
 * Builds a curl command string for the main HTTP request.
 * `to` must already have all variables resolved (no ${...} tokens).
 * When authKind is 'oauth-client-credentials', a <access_token> placeholder
 * is used because the actual token requires a live network call.
 */
export function buildRequestCurl(to: HttpRequestTypeOptions): string {
  const parts: string[] = [];

  // NOTE comment for OAuth so user understands the placeholder
  if (to.authKind === 'oauth-client-credentials') {
    parts.push(
      '# NOTE: This request uses OAuth 2 client credentials. Run the token curl first,',
      '# then replace <access_token> with the access_token value from the response.',
    );
  }

  // Base command
  const method = to.method === 'CUSTOM' ? (to.customMethod || 'GET') : to.method;
  const cmdParts: string[] = ['curl'];
  if (method !== 'GET') {
    cmdParts.push(`-X ${method}`);
  }

  // URL (with query params + API key in query)
  let url = to.url;
  const qp: string[] = [];
  for (const row of to.queryParams) {
    if (row.enabled && row.key) {
      qp.push(`${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`);
    }
  }
  if (to.authKind === 'apiKey' && to.authApiKey.location === 'query' && to.authApiKey.name) {
    qp.push(`${encodeURIComponent(to.authApiKey.name)}=${encodeURIComponent(to.authApiKey.value)}`);
  }
  if (qp.length > 0) {
    url += (url.includes('?') ? '&' : '?') + qp.join('&');
  }
  cmdParts.push(`'${url}'`);

  // Content-Type from body kind
  const contentTypeMap: Record<string, string> = {
    json: 'application/json',
    xml: 'application/xml',
    'form-urlencoded': 'application/x-www-form-urlencoded',
  };
  const bodyContentType = contentTypeMap[to.bodyKind];

  // Auth header
  if (to.authKind === 'basic') {
    const b64 = Buffer.from(`${to.authBasic.username}:${to.authBasic.password}`).toString('base64');
    cmdParts.push(`-H 'Authorization: Basic ${b64}'`);
  } else if (to.authKind === 'bearer') {
    cmdParts.push(`-H 'Authorization: Bearer ${to.authBearer.token}'`);
  } else if (to.authKind === 'apiKey' && to.authApiKey.location === 'header' && to.authApiKey.name) {
    cmdParts.push(`-H '${to.authApiKey.name}: ${to.authApiKey.value}'`);
  } else if (to.authKind === 'oauth-client-credentials') {
    cmdParts.push(`-H 'Authorization: Bearer <access_token>'`);
  }

  // Content-Type header (before user headers so user can override)
  if (bodyContentType) {
    cmdParts.push(`-H 'Content-Type: ${bodyContentType}'`);
  }

  // User-defined headers (enabled only)
  for (const row of to.headers) {
    if (row.enabled && row.key) {
      cmdParts.push(`-H '${row.key}: ${row.value}'`);
    }
  }

  // Body
  if (to.bodyKind === 'json' || to.bodyKind === 'raw' || to.bodyKind === 'xml') {
    if (to.bodyRaw) {
      cmdParts.push(`--data-raw '${to.bodyRaw}'`);
    }
  } else if (to.bodyKind === 'form-urlencoded') {
    for (const row of to.bodyForm) {
      if (row.enabled && row.key) {
        cmdParts.push(`--data-urlencode '${row.key}=${row.value}'`);
      }
    }
  }

  // Options
  if (!to.verifyTls) {
    cmdParts.push('--insecure');
  }
  if (to.followRedirects) {
    cmdParts.push('-L');
  }
  cmdParts.push(`--max-time ${Math.floor(to.timeoutMs / 1000)}`);

  parts.push(cmdParts.join(' '));
  return parts.join('\n');
}

/**
 * Builds a curl command string for the OAuth 2 token endpoint request.
 * Only call this when authKind === 'oauth-client-credentials'.
 * `to` must already have all variables resolved.
 */
export function buildTokenCurl(to: HttpRequestTypeOptions): string {
  const oauth = to.authOAuthClientCredentials;
  const cmdParts: string[] = ['curl', '-X POST', `'${oauth.tokenUrl}'`];

  if (oauth.clientAuth === 'header') {
    const encoded = `${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(oauth.clientSecret)}`;
    const b64 = Buffer.from(encoded).toString('base64');
    cmdParts.push(`-H 'Authorization: Basic ${b64}'`);
  }

  cmdParts.push(`-H 'Content-Type: application/x-www-form-urlencoded'`);
  cmdParts.push(`--data-urlencode 'grant_type=client_credentials'`);

  if (oauth.clientAuth === 'body') {
    cmdParts.push(`--data-urlencode 'client_id=${oauth.clientId}'`);
    cmdParts.push(`--data-urlencode 'client_secret=${oauth.clientSecret}'`);
  }

  if (oauth.scope) {
    cmdParts.push(`--data-urlencode 'scope=${oauth.scope}'`);
  }

  return cmdParts.join(' ');
}
