// OAuth state in one 0600 JSON file. There is one user and a handful of
// clients, so a file beats a database: no native dependencies, and a backup is
// a copy.

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export interface StoredToken {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface TokenPair {
  accessTokenHash: string;
  accessToken: StoredToken;
  refreshTokenHash: string;
  refreshToken: StoredToken;
}

interface Persisted {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, StoredToken>;
  refresh: Record<string, StoredToken>;
}

function emptyState(): Persisted {
  return { clients: {}, access: {}, refresh: {} };
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.some(
    (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
  );
}

export class FileOAuthStore {
  #data: Persisted;

  constructor(
    private readonly path: string,
    private readonly allowedRedirectHosts: string[],
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#data = this.#load();
    this.#purge();
    this.#save();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.#data.clients[clientId];
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at"> & {
      client_id?: string;
      client_id_issued_at?: number;
    },
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), this.allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this server");
    }
    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: client.client_id ?? `herdr-mcp-${randomUUID()}`,
      client_id_issued_at: client.client_id_issued_at ?? now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };
    this.#data.clients[registered.client_id] = registered;
    this.#save();
    return registered;
  }

  saveTokenPair(pair: TokenPair, consumedRefreshTokenHash?: string): boolean {
    if (consumedRefreshTokenHash !== undefined && !(consumedRefreshTokenHash in this.#data.refresh)) {
      return false;
    }
    if (consumedRefreshTokenHash !== undefined) {
      delete this.#data.refresh[consumedRefreshTokenHash];
    }
    this.#data.access[pair.accessTokenHash] = pair.accessToken;
    this.#data.refresh[pair.refreshTokenHash] = pair.refreshToken;
    this.#purge();
    this.#save();
    return true;
  }

  getAccessToken(hash: string): StoredToken | undefined {
    return this.#data.access[hash];
  }

  getRefreshToken(hash: string): StoredToken | undefined {
    return this.#data.refresh[hash];
  }

  deleteAccessToken(hash: string): void {
    if (hash in this.#data.access) {
      delete this.#data.access[hash];
      this.#save();
    }
  }

  deleteRefreshToken(hash: string): void {
    if (hash in this.#data.refresh) {
      delete this.#data.refresh[hash];
      this.#save();
    }
  }

  /** The store itself, in the shape the SDK's registration handler wants. */
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  #load(): Persisted {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Persisted>;
      return {
        clients: parsed.clients ?? {},
        access: parsed.access ?? {},
        refresh: parsed.refresh ?? {},
      };
    } catch {
      return emptyState();
    }
  }

  #purge(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [hash, record] of Object.entries(this.#data.access)) {
      if (record.expiresAt < now) delete this.#data.access[hash];
    }
    for (const [hash, record] of Object.entries(this.#data.refresh)) {
      if (record.expiresAt < now) delete this.#data.refresh[hash];
    }
  }

  #save(): void {
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
  }
}
