/**
 * Whether this installation is the hosted service or a customer's own server.
 *
 * Captivo Access has not needed the distinction before: every feature behaved
 * the same in both. Captivo ID is the first that must not: it is the platform's
 * own identity service, reachable only over the internet, and a self-hosted
 * installation whose sign-in depended on it would lock its owner out of their
 * own console the moment that link went down -- or permanently, in an
 * air-gapped network. The same reasoning already gates it in Captivo Portal.
 *
 * Until now the platform provider was "off" on a self-hosted box only because
 * the shipped compose file happens not to set its variables. That is an
 * accident, not a guarantee: anyone copying the hosted configuration would turn
 * it on. This makes it a decision.
 *
 * SELF-HOSTED IS THE SAFE DEFAULT. An installation that fails to declare itself
 * is treated as someone else's server, so the failure mode is a missing button
 * rather than a dependency nobody asked for.
 */

export type DeploymentMode = "saas" | "self-hosted";

export function deploymentMode(
  env: Record<string, string | undefined> = process.env,
): DeploymentMode {
  return env.CAPTIVO_DEPLOYMENT === "saas" ? "saas" : "self-hosted";
}

export function isSelfHosted(env?: Record<string, string | undefined>): boolean {
  return deploymentMode(env) === "self-hosted";
}
