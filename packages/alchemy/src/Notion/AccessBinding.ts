import { Schema } from "effect";

/** Existing resources are bindings, never candidates for creation on a 404. */
export const AccessBinding = Schema.Struct({
  botId: Schema.String.check(Schema.isUUID()),
  databaseId: Schema.String.check(Schema.isUUID()),
  dataSourceId: Schema.String.check(Schema.isUUID()),
  properties: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String }),
  ),
});
export type AccessBinding = typeof AccessBinding.Type;
