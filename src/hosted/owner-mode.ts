import type { StoreConfig } from "../config.js";
import type { ShopifyUserConnection, UserShopifyAccess } from "../runtime.js";
import { sha256, type AuthorizationServer } from "./oauth.js";

/**
 * Owner mode (OWNER_EMAIL): for one person running their own stores on their own server.
 *
 * - Only the owner's verified Shopify staff email may sign in. Everyone else is refused at the
 *   end of the Shopify sign-in, before any consent screen or session.
 * - The owner's tool calls do not use 24-hour online tokens. The server asks Shopify for an app
 *   token per store with the client credentials grant and renews it before it expires, so the
 *   stores stay connected with no daily reconnect. Shopify issues these tokens only when the app
 *   and the store belong to the same Shopify organization and the app is installed on the store.
 * - Calls act as the app, with the scopes of the app version in the Dev Dashboard.
 *
 * Tokens are kept in memory only, per store and app credentials, and never logged.
 */

/** Renew a token this long before Shopify says it expires. */
const RENEW_MARGIN_MS = 5 * 60_000;
/** Shopify documents 86399 seconds for client credentials tokens. */
const DEFAULT_TTL_SECONDS = 86_399;
const SHOP_HOST = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export const OWNER_ONLY_MESSAGE = "This server is reserved for its owner.";

/** OWNER_EMAIL, lower-cased, or undefined when owner mode is off. Throws on a malformed value. */
export function ownerEmailFromEnv(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  if (!email) return undefined;
  if (!EMAIL.test(email)) throw new Error("OWNER_EMAIL must be one email address (the owner's Shopify staff login).");
  return email;
}

export interface OwnerModeOptions {
  ownerEmail: string;
  /** Every configured store (unfiltered). */
  loadStores: () => Promise<StoreConfig[]>;
  clientId: (store: StoreConfig) => string | undefined;
  clientSecret: (store: StoreConfig) => string | undefined;
  storesUrl: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const tokenRequests = new Map<string, Promise<string>>();

export class OwnerMode {
  private readonly now: () => number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: OwnerModeOptions) {
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get ownerEmail(): string {
    return this.options.ownerEmail;
  }

  /**
   * Refuse every sign-in but the owner's. Both OAuth sign-ins (from AI apps) and page sign-ins
   * (the /stores page) finish in completeLogin, so wrapping it covers both.
   */
  restrictSignIn(auth: AuthorizationServer): void {
    const complete = auth.completeLogin.bind(auth);
    auth.completeLogin = async (record, email) => {
      if (email.trim().toLowerCase() !== this.options.ownerEmail) return auth.denyLogin(record, OWNER_ONLY_MESSAGE, email);
      return complete(record, email);
    };
  }

  /** The caller's access for one MCP request: app tokens for the owner, nothing for anyone else. */
  accessFor(email: string): UserShopifyAccess {
    const base = { storesUrl: this.options.storesUrl, connectUrl: () => this.options.storesUrl, now: this.now };
    if (email.trim().toLowerCase() !== this.options.ownerEmail) {
      // A session issued before OWNER_EMAIL was set, or to another person, reaches no store.
      return { ...base, tokens: new Map(), load: async () => {}, token: async () => undefined, blockedReason: OWNER_ONLY_MESSAGE };
    }
    const tokens = new Map<string, ShopifyUserConnection>();
    const stores = new Map<string, StoreConfig>();
    let loading: Promise<void> | undefined;
    const load = (): Promise<void> => {
      loading ??= (async () => {
        for (const store of await this.options.loadStores()) {
          if (!SHOP_HOST.test(store.shop) || !this.options.clientId(store) || !this.options.clientSecret(store)) continue;
          const alias = store.alias.toLowerCase();
          stores.set(alias, store);
          // Nominal: the server renews the real token itself, so the store always reads as connected.
          tokens.set(alias, { expiresAt: this.now() + DEFAULT_TTL_SECONDS * 1000 });
        }
      })();
      // A failed read is retried by the next caller rather than cached.
      loading.catch(() => { loading = undefined; });
      return loading;
    };
    const token = async (alias: string): Promise<string | undefined> => {
      await load();
      const store = stores.get(alias.toLowerCase());
      return store ? this.appToken(store) : undefined;
    };
    return { ...base, tokens, load, token };
  }

  /** A cached app token for one store, requested again shortly before it expires. */
  private appToken(store: StoreConfig): Promise<string> {
    const clientId = this.options.clientId(store)!;
    const clientSecret = this.options.clientSecret(store)!;
    const key = `${store.shop}\0${clientId}\0${sha256(clientSecret)}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > this.now() + RENEW_MARGIN_MS) return Promise.resolve(cached.token);
    const pending = tokenRequests.get(key);
    if (pending) return pending;
    const request = this.requestToken(store, clientId, clientSecret, key);
    tokenRequests.set(key, request);
    const forget = () => { if (tokenRequests.get(key) === request) tokenRequests.delete(key); };
    request.then(forget, forget);
    return request;
  }

  private async requestToken(store: StoreConfig, clientId: string, clientSecret: string, key: string): Promise<string> {
    let response: Response;
    let payload: Record<string, unknown>;
    try {
      response = await this.fetcher(`https://${store.shop}/admin/oauth/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString(),
        // "manual" and a status check rather than "error", which Workers' fetch does not accept.
        redirect: "manual",
        signal: AbortSignal.timeout(15_000)
      });
      payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Shopify did not answer the token request for ${store.alias}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok || typeof payload.access_token !== "string") {
      const reason = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
      const detail = typeof payload.error_description === "string" ? `: ${payload.error_description}` : "";
      throw new Error(
        `Shopify refused an app token for ${store.alias} (${reason}${detail}). In owner mode the app must be installed on the store, ` +
        "and the app and the store must belong to the same Shopify organization."
      );
    }
    const expiresIn = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : DEFAULT_TTL_SECONDS;
    tokenCache.set(key, { token: payload.access_token, expiresAt: this.now() + expiresIn * 1000 });
    return payload.access_token;
  }
}
