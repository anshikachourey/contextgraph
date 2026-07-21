/**
 * Re-export barrel for SIE generated transport types.
 *
 * These types are auto-generated from the Python OpenAPI contract
 * (ml-service/contracts/sie-openapi.json) using openapi-typescript.
 *
 * Do NOT handwrite transport types — regenerate with:
 *   npm run generate:sie-types
 */
export type {
  paths,
  webhooks,
  components,
  operations,
  $defs,
} from "./transport-types";
