// Installing the connector as a program (a Windows service, a systemd unit)
// instead of the Docker image: the commands an admin pastes on the host. The
// release's archive and its SHA256SUMS come from the project's public GitHub
// release for this console's version, and the install refuses a download that
// does not match (connector/selfupdate.go does the same for `connector update`).

export const RELEASE_DOWNLOAD = "https://github.com/captivo-io/captivo-access/releases/download";

type Vars = { code: string; managerUrl: string; tunnelUrl: string; version: string };

const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** PowerShell, from an elevated prompt. */
export function windowsInstallCommand(v: Vars): string {
  const base = `${RELEASE_DOWNLOAD}/v${v.version}`;
  const zip = `captivo-connector_${v.version}_windows_amd64.zip`;
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$d = Join-Path $env:TEMP 'captivo-connector'`,
    `New-Item -ItemType Directory -Force $d | Out-Null`,
    `Invoke-WebRequest ${psq(`${base}/${zip}`)} -OutFile "$d\\${zip}"`,
    `Invoke-WebRequest ${psq(`${base}/SHA256SUMS`)} -OutFile "$d\\SHA256SUMS"`,
    `$want = ((Select-String -Path "$d\\SHA256SUMS" -Pattern ${psq(zip)}).Line -split '\\s+')[0]`,
    `if ((Get-FileHash "$d\\${zip}" -Algorithm SHA256).Hash.ToLower() -ne $want.ToLower()) { throw 'The download does not match the release checksum' }`,
    `Expand-Archive "$d\\${zip}" -DestinationPath $d -Force`,
    `& (Get-ChildItem $d -Recurse -Filter connector.exe | Select-Object -First 1).FullName service install --manager-url ${psq(v.managerUrl)} --dataplane-url ${psq(v.tunnelUrl)} --pair-code ${psq(v.code)}`,
  ].join("; ");
}

/** Bash, on a host with systemd; it asks for sudo itself. */
export function linuxInstallCommand(v: Vars): string {
  const base = `${RELEASE_DOWNLOAD}/v${v.version}`;
  return [
    `set -e`,
    `a=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')`,
    `f=captivo-connector_${v.version}_linux_$a.tar.gz`,
    `d=$(mktemp -d -p /var/tmp)`, // /tmp is often mounted noexec
    `cd "$d"`,
    `curl -fsSLO ${shq(`${base}/`)}"$f" -O ${shq(`${base}/SHA256SUMS`)}`,
    `grep " $f\\$" SHA256SUMS | sha256sum -c -`,
    `tar xzf "$f"`,
    `sudo ./captivo-connector/connector service install --manager-url ${shq(v.managerUrl)} --dataplane-url ${shq(v.tunnelUrl)} --pair-code ${shq(v.code)}`,
  ].join("; ");
}

/** What an admin runs on the host of a connector installed as a program to update it. */
export function programUpdateCommand(platform: string): string {
  return platform === "windows" ? `& "C:\\Program Files\\Captivo\\Connector\\connector.exe" update` : "sudo captivo-connector update";
}

/** And to take it off the host (add --keep-data to keep the keys and recordings). */
export function programUninstallCommand(platform: string): string {
  return platform === "windows" ? `& "C:\\Program Files\\Captivo\\Connector\\connector.exe" service uninstall` : "sudo captivo-connector service uninstall";
}
