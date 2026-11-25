// The documented server-side upgrade, as one copy-pasteable line.
//
// `setup.sh` writes `CAPTIVO_VERSION=<release>` into `.env`, and the compose file reads that before its own
// default, so `git pull` alone never moves a server to a newer release. The command therefore sets the
// version in `.env` explicitly (adding the line on installs that predate it) before pulling the images.
const SEMVER = /^\d+\.\d+\.\d+$/;

export function serverUpgradeCommand(latestVersion: string): string {
  const v = latestVersion.replace(/^v/, "");
  // The version lands inside a shell command: anything but a plain x.y.z falls back to the generic
  // instruction, which still works but leaves the choice of version to the reader.
  const setVersion = SEMVER.test(v)
    ? `(grep -q '^CAPTIVO_VERSION=' .env && sed -i 's/^CAPTIVO_VERSION=.*/CAPTIVO_VERSION=${v}/' .env || echo 'CAPTIVO_VERSION=${v}' >> .env)`
    : `echo "Set CAPTIVO_VERSION in .env to the release you want, then run the next two commands"`;
  return `cd captivo-access/deploy && git pull && ${setVersion} && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`;
}
