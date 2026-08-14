/**
 * What a server *kind* can be given: mods, plugins, datapacks.
 *
 * These two types live in `types/` rather than beside the content service
 * because both ends of the question need them and the dependency may only point
 * one way: `types/provider.ts` declares the capability a provider publishes, and
 * `core/server/content.ts` reads it back when it lists a directory. A provider
 * interface cannot import from `core/`, so the vocabulary is here.
 *
 * No I/O, no UI — types only.
 */

/** Which list a piece of installed content belongs to. */
export type ContentSectionId = "mods" | "plugins" | "datapacks";

/**
 * Whether a kind loads each sort of content at all.
 *
 * A **complete record, not a partial one**: a `Record` makes a new section id a
 * compile error in every provider, whereas an optional flag is one a provider
 * silently omits and a UI then guesses about. The distinction it captures is
 * real and not derivable from the filesystem — a Paper server has no `mods/`
 * directory *and never will*, which is a different fact from "this Fabric server
 * has no mods installed yet", and only the provider knows which is which.
 */
export type ContentSupport = Readonly<Record<ContentSectionId, boolean>>;
