/**
 * The official Fleet API connection dance.
 *
 * Tesla requires a registered developer application, and that application must
 * prove it owns a domain by serving a public key at a well-known path. That is
 * the one genuinely awkward part of using the official API, so the setup page
 * walks through it and these helpers do the mechanical bits.
 *
 * If a domain is not worth the trouble, the app also accepts a refresh token
 * pasted in from any tool that already has one — see storeRefreshToken.
 */
import { FLEET_AUTH_BASE, FLEET_REGIONS } from './client.ts';

export type FleetAppConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
  audience: string;
};

/** Where to send the owner's browser to grant this app access to their car. */
export function authorizeUrl(app: FleetAppConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    scope: app.scopes,
    state,
    prompt_missing_scopes: 'true',
  });
  return `${FLEET_AUTH_BASE}/authorize?${params.toString()}`;
}

export type TokenPair = {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  scope: string | null;
};

function readTokens(json: unknown): TokenPair | null {
  if (typeof json !== 'object' || json === null) return null;
  const record = json as Record<string, unknown>;
  const access = typeof record.access_token === 'string' ? record.access_token : null;
  if (access === null) return null;
  return {
    accessToken: access,
    refreshToken: typeof record.refresh_token === 'string' ? record.refresh_token : null,
    expiresInSeconds: typeof record.expires_in === 'number' ? record.expires_in : 28_800,
    scope: typeof record.scope === 'string' ? record.scope : null,
  };
}

/** Trade the code Tesla sent to the redirect URI for tokens. */
export async function exchangeCode(app: FleetAppConfig, code: string): Promise<TokenPair> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code,
    audience: app.audience,
    redirect_uri: app.redirectUri,
  });

  const response = await fetch(`${FLEET_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Tesla rejected the authorization code (${response.status}): ${text.slice(0, 300)}`);

  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('Tesla returned a response that was not JSON');
  }
  const tokens = readTokens(json);
  if (tokens === null) throw new Error('Tesla returned no access token');
  return tokens;
}

/**
 * A partner token authenticates the application itself rather than a person.
 * It is needed once, to register the app's domain with Tesla.
 */
export async function partnerToken(app: FleetAppConfig): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: app.clientId,
    client_secret: app.clientSecret,
    scope: app.scopes.replace(/\boffline_access\b/, '').trim(),
    audience: app.audience,
  });
  const response = await fetch(`${FLEET_AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`could not get a partner token (${response.status}): ${text.slice(0, 300)}`);
  const tokens = readTokens(JSON.parse(text) as unknown);
  if (tokens === null) throw new Error('no partner access token in the response');
  return tokens.accessToken;
}

/**
 * Register the application's domain with Tesla. Must be done once per region,
 * after the public key is reachable at
 * https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
 */
export async function registerPartnerAccount(
  app: FleetAppConfig,
  domain: string,
  region: string,
): Promise<{ ok: boolean; status: number; detail: string }> {
  const token = await partnerToken(app);
  const base = FLEET_REGIONS[region] ?? FLEET_REGIONS.na ?? '';
  const response = await fetch(`${base}/api/1/partner_accounts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ domain }),
  });
  const detail = await response.text();
  return { ok: response.ok, status: response.status, detail: detail.slice(0, 500) };
}
