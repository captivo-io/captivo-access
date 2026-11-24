"use client";
import { useEffect, useState } from "react";
import { providerLabel, refProblem, refText, VAULT_PROVIDER_MIN_CONNECTOR, VAULT_PROVIDER_MIN_CONNECTOR_MORE, type VaultRef } from "@/lib/vault/providers";

export type CredentialSource = "local" | "hashicorp" | "cyberark" | "azure" | "aws";

const SOURCES: [CredentialSource, string][] = [["local", "Captivo"], ["hashicorp", "HashiCorp Vault"], ["cyberark", "CyberArk"], ["azure", "Azure Key Vault"], ["aws", "AWS Secrets Manager"]];

type F = Record<string, string>;

function Field({ label, opt, wide, children }: { label: string; opt?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={wide ? "rq-sec rot-wide" : "rq-sec"}>
      <span className="rq-label"><span>{label}{opt && <span className="t-muted rf-opt"> ({opt})</span>}</span></span>
      {children}
    </label>
  );
}

function Pick({ label, value, options, onPick }: { label: string; value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <div className="rq-sec"><span className="rq-label"><span>{label}</span></span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={value === k} className={value === k ? "seg-opt on" : "seg-opt"} onClick={() => onPick(k)}>{l}</button>)}
      </div>
    </div>
  );
}

/** The reference the fields describe, or null when they are untouched. */
export function refFromFields(source: CredentialSource, f: F): VaultRef | null {
  const t = (k: string) => f[k]?.trim() || undefined;
  const common = { caPem: f.tls === "ca" ? t("caPem") : undefined, insecure: f.tls === "insecure" ? (true as const) : undefined };
  const touched = ["address", "path", "token", "roleId", "secretId", "appId", "safe", "object", "tenantId", "clientId", "clientSecret", "secretName", "region", "awsSecretId", "user", "accountId"].some((k) => !!t(k));
  if (!touched) return null;
  switch (source) {
    case "hashicorp":
      return { provider: "hashicorp", address: f.address ?? "", ...common, namespace: t("namespace"), mount: t("mount"), path: f.path ?? "", field: t("field"), kvVersion: f.kv === "1" ? 1 : undefined,
        auth: f.auth === "approle" ? "approle" : "token", token: f.auth === "approle" ? undefined : f.token, roleId: f.auth === "approle" ? t("roleId") : undefined, secretId: f.auth === "approle" ? f.secretId : undefined, authMount: f.auth === "approle" ? t("authMount") : undefined };
    case "cyberark":
      return f.mode === "pvwa"
        ? { provider: "cyberark", mode: "pvwa", address: f.address ?? "", ...common, logonType: (t("logonType") as "ldap" | "radius" | "cyberark" | undefined), user: t("user"), password: f.password, accountId: t("accountId"), safe: t("safe"), object: t("object"), reason: t("reason"), clientCert: t("clientCert"), clientKey: t("clientKey") }
        : { provider: "cyberark", address: f.address ?? "", ...common, appId: t("appId"), safe: t("safe"), object: t("object"), folder: t("folder"), clientCert: t("clientCert"), clientKey: t("clientKey") };
    case "azure":
      return { provider: "azure", address: f.address ?? "", ...common, tenantId: t("tenantId") ?? "", clientId: t("clientId") ?? "", clientSecret: f.clientSecret ?? "", secretName: t("secretName") ?? "", secretVersion: t("secretVersion") };
    case "aws":
      return { provider: "aws", region: t("region") ?? "", address: t("address"), ...common, accessKeyId: t("accessKeyId"), secretAccessKey: f.secretAccessKey, sessionToken: f.sessionToken, awsSecretId: t("awsSecretId") ?? "", jsonKey: t("jsonKey") };
  }
  return null;
}

/**
 * Where a resource's credential comes from: typed here and kept by Captivo
 * (sealed to the connector), or fetched by the connector from the customer's
 * own vault each time a session needs it. For a vault the admin enters the
 * reference and how the connector signs in to the vault; that is sealed to the
 * connector like a password, so Captivo never sees it.
 */
export function CredentialSource({ source, onSource, saved, onRef }: {
  source: CredentialSource;
  onSource: (s: CredentialSource) => void;
  /** The resource already has a credential of this source: leave the fields empty to keep it. */
  saved: boolean;
  /** The sealed text for the current fields, or null while they are empty or incomplete. */
  onRef: (text: string | null, problem: string | null) => void;
}) {
  const [f, setF] = useState<F>({ auth: "token", kv: "2", tls: "system", mode: "ccp", logonType: "cyberark" });
  const set = (k: string) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));
  const val = (k: string) => f[k] ?? "";
  const pick = (k: string) => (v: string) => setF((c) => ({ ...c, [k]: v }));

  useEffect(() => {
    if (source === "local") return onRef(null, null);
    const ref = refFromFields(source, f);
    if (!ref) return onRef(null, saved ? null : "Enter where the credential lives.");
    const problem = refProblem(ref);
    onRef(problem ? null : refText(ref), problem);
  }, [source, f, saved, onRef]);

  const min = source === "hashicorp" || (source === "cyberark" && f.mode !== "pvwa") ? VAULT_PROVIDER_MIN_CONNECTOR : VAULT_PROVIDER_MIN_CONNECTOR_MORE;
  const pvwa = source === "cyberark" && f.mode === "pvwa";

  return (
    <div className="rq-sec rf-wide">
      <span className="rq-label"><span>Where the credential lives</span></span>
      <div className="seg wrap" role="radiogroup" aria-label="Where the credential lives">
        {SOURCES.map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={source === k} className={source === k ? "seg-opt on" : "seg-opt"} onClick={() => onSource(k)}>{l}</button>)}
      </div>
      {source !== "local" && (
        <div className="rot-rec-form">
          <p className="rf-hint rot-wide">
            The connector asks {providerLabel(source)} for the credential each time a session needs it and keeps nothing; nobody here ever sees it. What you enter below is sealed to the connector, like a password.
            Needs a connector on {min} or later that can reach the vault. {saved && "A reference is saved: leave these empty to keep it."}
          </p>
          {source === "cyberark" && <Pick label="How the connector asks" value={val("mode")} options={[["ccp", "Central Credential Provider"], ["pvwa", "REST API (PVWA)"]]} onPick={pick("mode")} />}
          {source !== "aws" && (
            <Field label={source === "azure" ? "Key Vault URL" : "Vault address"} wide={source === "azure"}>
              <input className="input mono" value={val("address")} onChange={set("address")} autoComplete="off" placeholder={source === "hashicorp" ? "https://vault.corp:8200" : source === "azure" ? "https://myvault.vault.azure.net" : "https://cyberark.corp"} />
            </Field>
          )}

          {source === "hashicorp" && (
            <>
              <Field label="Secret path"><input className="input mono" value={val("path")} onChange={set("path")} autoComplete="off" placeholder="servers/web01" /></Field>
              <Field label="KV mount" opt="secret"><input className="input mono" value={val("mount")} onChange={set("mount")} autoComplete="off" placeholder="secret" /></Field>
              <Field label="Field" opt="password"><input className="input mono" value={val("field")} onChange={set("field")} autoComplete="off" placeholder="password" /></Field>
              <Field label="Namespace" opt="optional"><input className="input mono" value={val("namespace")} onChange={set("namespace")} autoComplete="off" /></Field>
              <Pick label="The connector signs in with" value={val("auth")} options={[["token", "Token"], ["approle", "AppRole"]]} onPick={pick("auth")} />
              <Pick label="KV version" value={val("kv")} options={[["2", "v2"], ["1", "v1"]]} onPick={pick("kv")} />
              {f.auth === "approle" ? (
                <>
                  <Field label="Role id"><input className="input mono" value={val("roleId")} onChange={set("roleId")} autoComplete="off" /></Field>
                  <Field label="Secret id"><input className="input mono" type="password" value={val("secretId")} onChange={set("secretId")} autoComplete="new-password" /></Field>
                  <Field label="AppRole mount" opt="approle"><input className="input mono" value={val("authMount")} onChange={set("authMount")} autoComplete="off" placeholder="approle" /></Field>
                </>
              ) : (
                <Field label="Token" wide><input className="input mono" type="password" value={val("token")} onChange={set("token")} autoComplete="new-password" /></Field>
              )}
            </>
          )}

          {source === "cyberark" && !pvwa && (
            <>
              <Field label="Application id"><input className="input mono" value={val("appId")} onChange={set("appId")} autoComplete="off" placeholder="Captivo" /></Field>
              <Field label="Safe"><input className="input mono" value={val("safe")} onChange={set("safe")} autoComplete="off" /></Field>
              <Field label="Object"><input className="input mono" value={val("object")} onChange={set("object")} autoComplete="off" placeholder="web01-admin" /></Field>
              <Field label="Folder" opt="optional"><input className="input mono" value={val("folder")} onChange={set("folder")} autoComplete="off" placeholder="Root" /></Field>
            </>
          )}
          {pvwa && (
            <>
              <Pick label="Sign-in type" value={val("logonType")} options={[["cyberark", "CyberArk"], ["ldap", "LDAP"], ["radius", "RADIUS"]]} onPick={pick("logonType")} />
              <Field label="User"><input className="input mono" value={val("user")} onChange={set("user")} autoComplete="off" /></Field>
              <Field label="Password"><input className="input mono" type="password" value={val("password")} onChange={set("password")} autoComplete="new-password" /></Field>
              <Field label="Safe"><input className="input mono" value={val("safe")} onChange={set("safe")} autoComplete="off" /></Field>
              <Field label="Account name"><input className="input mono" value={val("object")} onChange={set("object")} autoComplete="off" placeholder="web01-admin" /></Field>
              <Field label="Account id" opt="instead of safe and name"><input className="input mono" value={val("accountId")} onChange={set("accountId")} autoComplete="off" placeholder="12_3" /></Field>
              <Field label="Reason" opt="logged in CyberArk"><input className="input mono" value={val("reason")} onChange={set("reason")} autoComplete="off" placeholder="Captivo Access session" /></Field>
              <p className="rf-hint rot-wide">The user needs the Retrieve accounts permission on the safe. An account that asks for a reason is given the one above; one that needs dual control or a ticket cannot be fetched unattended.</p>
            </>
          )}
          {source === "cyberark" && (
            <>
              <Field label="Client certificate" opt="PEM, if the server asks for one" wide><textarea className="textarea mono" rows={3} value={val("clientCert")} onChange={set("clientCert")} placeholder={"-----BEGIN CERTIFICATE-----"} spellCheck={false} /></Field>
              <Field label="Its private key" wide><textarea className="textarea mono" rows={3} value={val("clientKey")} onChange={set("clientKey")} placeholder={"-----BEGIN PRIVATE KEY-----"} spellCheck={false} /></Field>
            </>
          )}

          {source === "azure" && (
            <>
              <Field label="Secret name"><input className="input mono" value={val("secretName")} onChange={set("secretName")} autoComplete="off" /></Field>
              <Field label="Version" opt="latest"><input className="input mono" value={val("secretVersion")} onChange={set("secretVersion")} autoComplete="off" /></Field>
              <Field label="Tenant id"><input className="input mono" value={val("tenantId")} onChange={set("tenantId")} autoComplete="off" /></Field>
              <Field label="Application (client) id"><input className="input mono" value={val("clientId")} onChange={set("clientId")} autoComplete="off" /></Field>
              <Field label="Client secret" wide><input className="input mono" type="password" value={val("clientSecret")} onChange={set("clientSecret")} autoComplete="new-password" /></Field>
              <p className="rf-hint rot-wide">An app registration with the Key Vault Secrets User role (or a get-secrets access policy) on this vault.</p>
            </>
          )}

          {source === "aws" && (
            <>
              <Field label="Region"><input className="input mono" value={val("region")} onChange={set("region")} autoComplete="off" placeholder="eu-central-1" /></Field>
              <Field label="Secret name or ARN"><input className="input mono" value={val("awsSecretId")} onChange={set("awsSecretId")} autoComplete="off" placeholder="prod/web01" /></Field>
              <Field label="Field" opt="for a JSON secret"><input className="input mono" value={val("jsonKey")} onChange={set("jsonKey")} autoComplete="off" placeholder="password" /></Field>
              <Field label="Endpoint" opt="a VPC endpoint"><input className="input mono" value={val("address")} onChange={set("address")} autoComplete="off" placeholder="https://secretsmanager.eu-central-1.amazonaws.com" /></Field>
              <Field label="Access key id" opt="empty: the connector's AWS_ACCESS_KEY_ID"><input className="input mono" value={val("accessKeyId")} onChange={set("accessKeyId")} autoComplete="off" /></Field>
              <Field label="Secret access key"><input className="input mono" type="password" value={val("secretAccessKey")} onChange={set("secretAccessKey")} autoComplete="new-password" /></Field>
              <Field label="Session token" opt="for temporary keys" wide><input className="input mono" type="password" value={val("sessionToken")} onChange={set("sessionToken")} autoComplete="new-password" /></Field>
              <p className="rf-hint rot-wide">An IAM user or role with secretsmanager:GetSecretValue on this secret.</p>
            </>
          )}

          <div className="rq-sec rot-wide"><span className="rq-label"><span>The vault&apos;s certificate</span></span>
            <div className="seg" role="radiogroup" aria-label="Vault certificate">
              {([["system", "Public CA"], ["ca", "Our CA"], ["insecure", "Don't check"]] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={f.tls === k} className={f.tls === k ? "seg-opt on" : "seg-opt"} onClick={() => setF((c) => ({ ...c, tls: k }))}>{l}</button>)}
            </div>
            {f.tls === "ca" && <textarea className="textarea mono" rows={3} value={val("caPem")} onChange={set("caPem")} placeholder={"-----BEGIN CERTIFICATE-----\n(your CA)"} spellCheck={false} />}
          </div>
        </div>
      )}
    </div>
  );
}
