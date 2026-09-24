/**
 * Where this product's container images live.
 *
 * ONE PLACE, because the registry namespace is not only a code constant: it
 * appears in the two compose files an operator runs, in the install and
 * quickstart docs they copy commands from, and in the connector command the
 * panel generates for them. When the repository moved from a personal account
 * to the captivo-io organisation (2026-09-24) that string had to change in nine
 * files at once, and a string spread over nine files is a string that will be
 * half-changed next time.
 *
 * The compose files and the markdown cannot import this module, so they cannot
 * be made to derive from it -- a test compares them against it instead, which
 * turns a half-change into a failing build rather than an install command that
 * pulls an image nobody published.
 *
 * NOT DERIVED FROM AN ENVIRONMENT VARIABLE. The panel hands these commands to a
 * person to paste on their own machine; a value only our server knows would
 * produce a command that works here and not there. The publishing workflow
 * derives the same namespace from `github.repository_owner`, so a future move
 * changes this constant and the workflow needs no edit at all.
 */
export const IMAGE_REGISTRY = "ghcr.io";
export const IMAGE_OWNER = "captivo-io";
export const IMAGE_PREFIX = `${IMAGE_REGISTRY}/${IMAGE_OWNER}/captivo-access`;

/** Every image this product publishes, as the workflow's build matrix names them. */
export const PUBLISHED_IMAGES = [
  "manager",
  "dataplane",
  "connector",
  "migrate",
  "kasm-browser",
] as const;

export type PublishedImage = (typeof PUBLISHED_IMAGES)[number];

/** Fully qualified reference, e.g. accessImage("connector") -> ".../captivo-access-connector:latest". */
export function accessImage(name: PublishedImage, tag = "latest"): string {
  return `${IMAGE_PREFIX}-${name}:${tag}`;
}
