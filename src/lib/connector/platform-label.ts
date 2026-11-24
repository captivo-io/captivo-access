/** How the console names a connector installed as a program (Connector.platform); null for the Docker image. */
export const platformLabel = (p: string | null | undefined): string | null => (p === "windows" ? "Windows" : p === "linux" ? "Linux service" : null);
