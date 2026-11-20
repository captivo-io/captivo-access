# Log forwarding

Captivo Access can send its audit log to your SIEM as records are written,
normally within a few seconds. Set it up under **Platform → Log forwarding** in
the console (admins with the *configure* capability). A workspace can have up to
five destinations; each gets the same records, filtered by its own switches.

There are two ways to reach a SIEM:

| Destination | Sent by | Use it when |
|---|---|---|
| **Syslog** (UDP, TCP or TLS) | one of your connectors | the SIEM is on your own network (QRadar, ArcSight, Sentinel through the Azure Monitor Agent, Wazuh, Graylog, syslog-ng, rsyslog) |
| **Splunk HEC**, **Datadog**, **HTTPS** | Captivo directly | the SIEM takes logs over the internet |

## Syslog through a connector

The control plane renders each record as an RFC 5424 syslog message and hands a
batch to the connector you chose, over the tunnel the connector already holds.
The connector writes it to the SIEM's address. Nothing on your network needs to
be reachable from the internet, and the connector keeps nothing on disk.

- **Connector**: 2.42.0 or newer. Older connectors are listed but cannot be
  chosen. An optional second connector is used while the first is offline.
- **Transport**: TLS (RFC 5425, default port 6514) is encrypted and checks the
  SIEM's certificate against the system roots, or against the **CA certificate**
  you paste when the SIEM uses your own CA. TCP (514) confirms delivery
  unencrypted. UDP (514, RFC 5426) sends one message per datagram and has no
  confirmation: a record lost on the network is not sent again.
- **Framing** (TCP and TLS): one message per line (the default most SIEMs
  expect), or octet counting (RFC 6587) if yours asks for it.
- **Message format**: CEF, which QRadar, ArcSight and Sentinel read without a
  parser, or JSON for Splunk, Elastic, Wazuh and Graylog.
- **Facility**: local0 by default. The severity is *warning* for a denial,
  *notice* for an admin's action, *informational* otherwise.
- **Egress**: the SIEM's `host:port` is checked against the connector's egress
  boundary like any other target. If the connector's egress is narrowed in
  Policy, or limited by `ALLOWED_TARGETS`, add the SIEM to it.

A message looks like this (CEF):

```
<134>1 2026-11-20T09:14:03.120Z acme.cloud.captivo.io captivo-access - session - CEF:0|Captivo|Access|2.42.0|session.open|Session opened|3|rt=1795166043120 act=session.open outcome=allow suser=ayse@vendor.example src=203.0.113.24 dhost=dc01.corp.local requestClientApplication=Mozilla/5.0 cs1Label=Resource cs1=DC01 cs3Label=Company cs3=Vendor Ltd cs4Label=Workspace cs4=acme externalId=access-1042 msg=ayse@vendor.example opened a session to DC01
```

The HOSTNAME is the workspace's console host, APP-NAME is `captivo-access` and
MSGID is the record's category (`session`, `file`, `request`, `admin`).

## Cloud destinations

These are called from Captivo, so the address must be reachable from the
internet. On Captivo Cloud the address must be HTTPS and may not resolve to a
private network.

- **Splunk HEC**: the collector's address (without a path,
  `/services/collector/event` is used) and an HEC token. Events are sent with
  `sourcetype=captivo:access` and `source=captivo-access`.
- **Datadog**: the site (US1, US3, US5, EU1, AP1, US1-FED) and an API key.
  Records arrive with `ddsource:captivo-access` and the tags `workspace`,
  `category` and `outcome`; denials have status `warn`.
- **HTTPS**: any endpoint that takes a JSON array by POST, with an optional
  header (for example `Authorization: Bearer …`).

Tokens, keys and header values are stored encrypted and never shown again.

## What is sent

Each destination chooses what it receives:

| Switch | Records | `action` |
|---|---|---|
| Sessions | a remote desktop, SSH, isolated browser or web app session opened and closed | `session.open`, `session.close` |
| File transfers | uploads and downloads | `file.upload`, `file.download`, `file.*_partial` |
| Denied access | every refusal, whatever its kind | `access.deny`, `*.deny` |
| Admin activity | changes made in the console, recording erasures | the console action, e.g. `grant.create`, `config.smtp_update` |
| Every web request (off by default) | each page and API call in web apps | `access.request` |

A denial is sent when either *Denied access* or its own kind's switch is on.
Keystrokes and recordings are never forwarded.

The JSON form of a record (the cloud destinations, and syslog in JSON format):

```json
{
  "@timestamp": "2026-11-20T09:14:07.120Z",
  "workspace": "acme",
  "category": "request",
  "action": "access.deny",
  "name": "Access denied",
  "outcome": "deny",
  "message": "ayse@vendor.example GET /reports on Finance app: denied, outside the grant's hours",
  "user": { "email": "ayse@vendor.example", "name": "Ayşe Yılmaz", "company": "Vendor Ltd" },
  "resource": { "id": "cm0fin", "name": "Finance app", "host": "finance.corp.local" },
  "http": { "method": "GET", "path": "/reports", "status": 403 },
  "client": { "ip": "203.0.113.24", "userAgent": "Mozilla/5.0" },
  "reason": "Outside the grant's hours",
  "log": { "source": "access", "seq": "1043", "hash": "…" }
}
```

`log.source` and `log.seq` place the record in Captivo's hash-chained audit log
(the CEF `externalId` carries the same, as `access-1043`), so a SIEM rule can
spot a gap and the record can be checked against the console's chain.

## Delivery

The audit log itself is the queue. Each destination keeps a position in it and
moves that position only after a batch was delivered; a batch that could not be
delivered is sent again on the next attempt. So a SIEM can, rarely, see a record
twice, but never misses one (UDP excepted, see above).

- New records start a delivery within seconds. A background job every five
  minutes picks up anything a restart left behind.
- After a failure the next attempt waits 30 seconds, then doubling up to five
  minutes. **Retry now** on the destination tries at once.
- The destination's card shows when it last delivered, how many records it has
  sent, how many are waiting, and the last error in words.
- A new destination starts with the next record written, or, if you choose
  **Also the last 24 hours**, with the records of the past day.
- **Send test** delivers one record ("Test from Captivo Access") with the form's
  values, saved or not.

## Troubleshooting

| Message | What to do |
|---|---|
| The connector is offline | Check the connector; records wait until it is back (or set a second connector). |
| The connector is older than 2.42.0 | Update it from Connectors. |
| The connector couldn't deliver: target not allowed | Add the SIEM's `host:port` to the connector's egress in Policy or `ALLOWED_TARGETS`. |
| The connector couldn't deliver: unreachable … connection refused | The SIEM isn't listening on that port, or a firewall between the connector and the SIEM blocks it. |
| The connector couldn't deliver: tls: … unknown authority | Paste the CA that signed the SIEM's certificate. |
| The endpoint answered HTTP 401/403 | The token or key is wrong or lacks permission. |
| That address is on a private network | Captivo Cloud can't reach your network: use syslog through a connector. |
