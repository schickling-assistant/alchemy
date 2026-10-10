import { Config, Context, Effect, Layer, Redacted } from "effect";

/**
 * A Notion integration token, kept redacted until constructing the Authorization
 * header. Inject with Layer.succeed(Credentials, { token: Redacted.make(token) })
 * when a caller already owns credential resolution. Share the existing database
 * with that integration; credentials do not create or grant access to resources.
 */
export class Credentials extends Context.Service<
  Credentials,
  { readonly token: Redacted.Redacted<string> }
>()("Notion.Credentials") {}

/** Read NOTION_TOKEN through Effect Config without exposing its plaintext value. */
export const fromEnv = () =>
  Layer.effect(
    Credentials,
    Effect.map(Config.Redacted("NOTION_TOKEN"), (token) => ({ token })),
  );
