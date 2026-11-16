// Backing up a connector's own data: the commands the console shows (Backup on
// the Connectors page) and docs/install.md explains. Pure + db-free.
//
// The connector's data volume holds:
//   recording.key  opens every recording on this connector; nobody else has it
//   vault.key      opens the resource passwords sealed to this connector
//   recordings/    the recordings themselves (encrypted with recording.key)
//   token          the connector's sign-in to the service; deliberately left out
//                  of backups (re-pairing issues a new one in a minute)
//
// Lose recording.key and the recordings are gone for good; lose vault.key and
// each remote-desktop password must be entered again. Restore the keys BEFORE a
// replacement connector starts for the first time: it makes new keys otherwise,
// and anything recorded with those would be unreadable after the restore.
import { accessImage } from "@/lib/images";
import { CONNECTOR_DATA_VOLUME } from "@/lib/connector/repair";

const KEYS_DIR = "captivo-connector-keys";

// Keys only (two small files): the minimum that keeps recordings readable and
// sealed passwords usable. Run on the connector's host.
export function buildKeysBackupCommand(): string {
  return (
    `mkdir -p ${KEYS_DIR} && chmod 700 ${KEYS_DIR} && ` +
    `docker cp access-connector:/data/recording.key ${KEYS_DIR}/ && ` +
    `{ docker cp access-connector:/data/vault.key ${KEYS_DIR}/ 2>/dev/null || echo "no vault.key yet: update the connector, then back up again"; } && ` +
    `chmod 600 ${KEYS_DIR}/*.key && ls -l ${KEYS_DIR}`
  );
}

// Keys and recordings, as one archive; the token is left out.
export function buildFullBackupCommand(): string {
  return (
    `docker run --rm --user 0 --entrypoint tar -v ${CONNECTOR_DATA_VOLUME}:/data:ro ${accessImage("connector")} ` +
    `-czf - -C /data --exclude=./token . > captivo-connector-$(date +%F).tar.gz && ` +
    `chmod 600 captivo-connector-$(date +%F).tar.gz && ls -l captivo-connector-$(date +%F).tar.gz`
  );
}

// Puts backed-up keys into the data volume (creating it on a new host), owned
// by the connector's user. Stops the connector first if there is one.
export function buildKeysRestoreCommand(): string {
  return (
    `docker stop access-connector >/dev/null 2>&1; ` +
    `docker run --rm --user 0 --entrypoint sh -v ${CONNECTOR_DATA_VOLUME}:/data -v "$PWD/${KEYS_DIR}":/backup:ro ${accessImage("connector")} ` +
    `-c 'cp /backup/*.key /data/ && chown 10001:10001 /data/*.key && chmod 600 /data/*.key && ls -l /data'; ` +
    `docker start access-connector >/dev/null 2>&1 || true`
  );
}

// Unpacks a full backup into the data volume. FILE is the archive's name.
export function buildFullRestoreCommand(file = "captivo-connector-YYYY-MM-DD.tar.gz"): string {
  return (
    `docker stop access-connector >/dev/null 2>&1; ` +
    `docker run --rm --user 0 --entrypoint sh -v ${CONNECTOR_DATA_VOLUME}:/data -v "$PWD":/backup:ro ${accessImage("connector")} ` +
    `-c 'tar -xzf /backup/${file} -C /data && chown -R 10001:10001 /data && ls -l /data'; ` +
    `docker start access-connector >/dev/null 2>&1 || true`
  );
}
