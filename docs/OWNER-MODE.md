# Owner mode

Owner mode is for one person running their own stores on their own hosted server. Turn it on by setting `OWNER_EMAIL` to your Shopify staff login email.

## What changes

- **Only you can sign in.** Sign-in still goes through Shopify, but any other verified email is refused at the end of the sign-in, before the consent screen. A session issued to anyone else reaches no store.
- **No daily reconnect.** Tool calls no longer use your 24-hour online tokens. For each store the server asks Shopify for an app token with the [client credentials grant](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens), keeps it in memory, and requests a new one five minutes before it expires.
- **Calls act as the app.** What the server can do in a store is set by the scopes of the app version in the Dev Dashboard, not by your staff permissions. Keep the app read-only until you need writes.

## Requirements

- The Shopify app and every configured store must belong to the same Shopify organization (check in the Dev Dashboard), and the app must be installed on each store. Otherwise Shopify refuses the token and the tool call says so.
- `SHOPIFY_APP_CLIENT_ID` and `SHOPIFY_APP_CLIENT_SECRET` must be set, as for the normal hosted setup. A store with its own `SHOPIFY_CLIENT_ID_<ALIAS>` and `SHOPIFY_CLIENT_SECRET_<ALIAS>` uses those.
- Set `SHOPIFY_APP_SCOPES` to the scopes of the app version (for example `read_products,read_orders,read_inventory,read_locations,read_customers`) so the sign-in asks for the same access.

## How long a sign-in lasts

The sign-in from Claude or another AI app still ends after `OAUTH_SESSION_MAX_AGE_SECONDS` (7 days by default). For fewer sign-ins, raise it together with the refresh token lifetime, for example to 90 days:

```
OAUTH_SESSION_MAX_AGE_SECONDS=7776000
OAUTH_REFRESH_TOKEN_TTL_SECONDS=7776000
```

A longer session is a longer window for a stolen one.

## Cutting access

To stop all store access at once, rotate the app's client secret in the Dev Dashboard. The server can no longer get app tokens, and tokens it already holds stop working once Shopify revokes them or within 24 hours. Set the new secret on the server to resume.

## The /stores page

The page still lists your sign-in connections, which expire after 24 hours as before. In owner mode they are only used to sign in, so an expired one needs no action.
