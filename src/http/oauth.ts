// Single-user OAuth 2.1 provider: authorization code + PKCE S256, dynamic
// client registration, and a password page instead of a second identity
// provider. Adapted from DevSpace's SingleUserOAuthProvider (MIT).

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { Response } from "express";
import { AccessDeniedError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

import { FileOAuthStore } from "./oauth-store.js";

export interface OAuthConfig {
  ownerPassword: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  scopes: string[];
  allowedRedirectHosts: string[];
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formHtml(params: {
  error?: string;
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
}): string {
  const scopeText = params.scopes.length > 0 ? params.scopes.join(" ") : "mcp";
  const resourceText = params.resource?.href ?? "herdr MCP endpoint";
  const error = params.error ? `<p class="error">${htmlEscape(params.error)}</p>` : "";
  const hiddenFields = Object.entries(params.fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `        <input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}" />`)
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>连接 herdr</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: #0b1120; color: #e2e8f0; }
      main { max-width: 460px; margin: 12vh auto; padding: 32px; background: #111827; border: 1px solid #334155; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
      h1 { margin: 0 0 12px; font-size: 26px; }
      p { line-height: 1.55; color: #cbd5e1; }
      dl { padding: 16px; background: #020617; border-radius: 12px; }
      dt { color: #94a3b8; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
      dd { margin: 4px 0 12px; word-break: break-word; }
      label { display: block; margin: 18px 0 8px; font-weight: 600; }
      input { box-sizing: border-box; width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid #475569; background: #020617; color: #e2e8f0; font-size: 16px; }
      button { margin-top: 18px; width: 100%; border: 0; border-radius: 10px; padding: 12px 14px; font-weight: 700; color: #020617; background: #38bdf8; cursor: pointer; }
      .error { color: #fecaca; background: #7f1d1d; border-radius: 10px; padding: 10px 12px; }
      .warning { color: #fde68a; }
    </style>
  </head>
  <body>
    <main>
      <h1>连接 herdr</h1>
      <p class="warning">这只应是你自己把 ChatGPT 连到自己的终端。授权后，对方可以读取终端屏幕并向终端里的程序发送文字。</p>
      ${error}
      <dl>
        <dt>客户端</dt><dd>${htmlEscape(params.clientName)}</dd>
        <dt>权限范围</dt><dd>${htmlEscape(scopeText)}</dd>
        <dt>资源</dt><dd>${htmlEscape(resourceText)}</dd>
      </dl>
      <form method="post">
${hiddenFields}
        <label for="owner_password">Owner 口令</label>
        <input id="owner_password" name="owner_password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">授权</button>
      </form>
    </main>
  </body>
</html>`;
}

export class SingleUserOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly #codes = new Map<string, AuthorizationCodeRecord>();
  readonly #store: FileOAuthStore;
  readonly #resourceServerUrl: URL;

  constructor(
    private readonly config: OAuthConfig,
    resourceServerUrl: URL,
    stateFile: string,
  ) {
    this.#resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.#store = new FileOAuthStore(stateFile, config.allowedRedirectHosts);
    this.clientsStore = this.#store.clientsStore;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.#resourceServerUrl })) {
      throw new InvalidRequestError("Invalid OAuth resource");
    }
    const requestedScopes = params.scopes ?? this.config.scopes;
    if (!requestedScopes.every((scope) => this.config.scopes.includes(scope))) {
      throw new InvalidRequestError("Requested scope is not supported");
    }

    if (res.req.method !== "POST") {
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          clientName: client.client_name ?? client.client_id,
          scopes: requestedScopes,
          resource: params.resource,
          fields: formFields(client, params),
        }),
      );
      return;
    }

    const provided = String((res.req.body as { owner_password?: string } | undefined)?.owner_password ?? "");
    if (!safeEquals(provided, this.config.ownerPassword)) {
      res.status(401).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(
        formHtml({
          error: "口令不正确。",
          clientName: client.client_name ?? client.client_id,
          scopes: requestedScopes,
          resource: params.resource,
          fields: formFields(client, params),
        }),
      );
      return;
    }

    const code = `code-${randomUUID()}`;
    this.#codes.set(code, {
      clientId: client.client_id,
      params: { ...params, scopes: requestedScopes },
      expiresAtMs: Date.now() + CODE_TTL_MS,
    });

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (params.state !== undefined) redirectUrl.searchParams.set("state", params.state);
    res.redirect(302, redirectUrl.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.#validCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.#validCode(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.#resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }
    this.#codes.delete(authorizationCode);
    return this.#issueTokens(client.client_id, record.params.scopes ?? this.config.scopes, record.params.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = hashToken(refreshToken);
    const record = this.#store.getRefreshToken(hash);
    if (!record || record.clientId !== client.client_id || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    if (resource && !checkResourceAllowed({ requestedResource: resource, configuredResource: this.#resourceServerUrl })) {
      throw new InvalidGrantError("Invalid resource");
    }
    const requestedScopes = scopes ?? record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) {
      throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    }
    return this.#issueTokens(
      client.client_id,
      requestedScopes,
      resource ?? (record.resource ? new URL(record.resource) : undefined),
      hash,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.#store.getAccessToken(hashToken(token));
    if (!record || record.expiresAt < Math.floor(Date.now() / 1000)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: record.resource ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const hash = hashToken(request.token);
    this.#store.deleteAccessToken(hash);
    this.#store.deleteRefreshToken(hash);
  }

  #validCode(client: OAuthClientInformationFull, authorizationCode: string): AuthorizationCodeRecord {
    const record = this.#codes.get(authorizationCode);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    return record;
  }

  #issueTokens(clientId: string, scopes: string[], resource?: URL, consumedRefreshTokenHash?: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const accessExpiresAt = now + this.config.accessTokenTtlSeconds;
    const refreshExpiresAt = now + this.config.refreshTokenTtlSeconds;

    const saved = this.#store.saveTokenPair(
      {
        accessTokenHash: hashToken(accessToken),
        accessToken: { clientId, scopes, expiresAt: accessExpiresAt, resource: resource?.href },
        refreshTokenHash: hashToken(refreshToken),
        refreshToken: { clientId, scopes, expiresAt: refreshExpiresAt, resource: resource?.href },
      },
      consumedRefreshTokenHash,
    );
    if (!saved) throw new InvalidGrantError("Invalid refresh token");

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}

function formFields(
  client: OAuthClientInformationFull,
  params: AuthorizationParams,
): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}
