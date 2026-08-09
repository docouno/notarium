/** A deterministic source-data failure. Hosts treat this as terminal: retrying
 *  the same uploaded bytes cannot change the result. Kept outside importer.ts so
 *  individual format boundaries can classify their own parse failures without a
 *  dispatcher/format import cycle. */
export class ImportError extends Error {}
