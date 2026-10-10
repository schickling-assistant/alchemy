import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Provider from "../Provider.ts";
import { AccessAssertion, AccessAssertionProvider } from "./AccessAssertion.ts";
import * as Credentials from "./Credentials.ts";
import { SchemaOwnership, SchemaOwnershipProvider } from "./SchemaOwnership.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("Notion") {}

/**
 * Register Notion's observe/assert and adopt/additive-schema providers.
 * NOTION_TOKEN is resolved through Effect Config and stays outside resource state.
 *
 * @example
 * ```typescript
 * import * as Notion from "alchemy/Notion";
 * // Include Notion.providers() in your stack's providers layer.
 * // Supply NOTION_TOKEN using your ConfigProvider, not resource props.
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([AccessAssertion, SchemaOwnership])).pipe(
    Layer.provideMerge(Layer.mergeAll(AccessAssertionProvider(), SchemaOwnershipProvider())),
    Layer.provideMerge(Credentials.fromEnv()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
