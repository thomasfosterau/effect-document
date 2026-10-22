/**
 * The profile/subset system: phantom-typed documents (`Doc<F>`), `Profile`
 * definitions, conformance checking, and the `widen`/`narrow` transforms.
 */

export * from "./profile.ts";
export * from "./collect.ts";
export * from "./narrow.ts";
/** The built-in profiles (`Csv`, `Spreadsheet`, `Markdown`, `Html`, `Presentation`, `Full`) as one namespace. */
export * as Profiles from "./profiles.ts";
