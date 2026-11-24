"use client";
import { useEffect, useState } from "react";
import { providerLabel, refProblem, refText, type VaultRef } from "@/lib/vault/providers";

export type CredentialSource = "local" | "hashicorp" | "cyberark";

/**
 * Where a resource's credential comes from: typed here and kept by Captivo
 * (sealed to the connector), or fetched by the connector from the customer's
 * own HashiCorp Vault or CyberArk each time a session needs it. For a vault the
 * admin enters the reference and how the connector signs in to the vault; that
 * is sealed to the connector like a password, so Captivo never sees it.
 */
export function CredentialSource({ source, onSource, saved, onRef, minConnector }: {
  source: CredentialSource;
  onSource: (s: CredentialSource) => void;
  /** The resource already has a credential of this source: leave the fields empty to keep it. */
  saved: boolean;
  /** The sealed text for the current fields, or null while they are empty or incomplete. */
  onRef: (text: string | null, problem: string | null) => void;
  minConnector: string;
}) {
  const [f, setF] = useState<Record<string, string>>({ auth: "token", kv: "2", tls: "system" });
  const set = (k: string) => (e: { target: { value: string } }) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  useEffect(() => {
    if (source === "local") return onRef(null, null);
    const touched = ["address", "path", "token", "roleId", "secretId", "appId", "safe", "object"].some((k) => !!f[k]?.trim());
    if (!touched) return onRef(null, saved ? null : "Enter where the credential lives.");
    const common = { address: f.address ?? "", caPem: f.tls === "ca" ? f.caPem?.trim() : undefined, insecure: f.tls === "insecure" ? true : undefined };
    const ref: VaultRef = source === "hashicorp"
      ? { provider: "hashicorp", ...common, namespace: f.namespace?.trim(), mount: f.mount?.trim(), path: f.path ?? "", field: f.field?.trim(), kvVersion: f.kv === "1" ? 1 : undefined,
          auth: f.auth === "approle" ? "approle" : "token", token: f.auth === "approle" ? undefined : f.token, roleId: f.auth === "approle" ? f.roleId?.trim() : undefined, secretId: f.auth === "approle" ? f.secretId : undefined, authMount: f.auth === "approle" ? f.authMount?.trim() : undefined }
      : { provider: "cyberark", ...common, appId: f.appId?.trim() ?? "", safe: f.safe?.trim() ?? "", object: f.object?.trim() ?? "", folder: f.folder?.trim(), clientCert: f.clientCert?.trim(), clientKey: f.clientKey?.trim() };
    const problem = refProblem(ref);
    onRef(problem ? null : refText(ref), problem);
  }, [source, f, saved, onRef]);

  return (
    <div className="rq-sec rf-wide">
      <span className="rq-label"><span>Where the credential lives</span></span>
      <div className="seg" role="radiogroup" aria-label="Where the credential lives">
        {([["local", "Captivo"], ["hashicorp", "HashiCorp Vault"], ["cyberark", "CyberArk"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={source === k} className={source === k ? "seg-opt on" : "seg-opt"} onClick={() => onSource(k)}>{l}</button>
        ))}
      </div>
      {source !== "local" && (
        <div className="rot-rec-form">
          <p className="rf-hint rot-wide">
            The connector asks {providerLabel(source)} for the credential each time a session needs it and keeps nothing; nobody here ever sees it. The address and sign-in below are sealed to the connector, like a password.
            Needs a connector on {minConnector} or later that can reach the vault. {saved && "A reference is saved: leave these empty to keep it."}
          </p>
          <label className="rq-sec"><span className="rq-label"><span>Vault address</span></span>
            <input className="input mono" value={f.address ?? ""} onChange={set("address")} autoComplete="off" placeholder={source === "hashicorp" ? "https://vault.corp:8200" : "https://cyberark.corp"} /></label>
          {source === "hashicorp" ? (
            <>
              <label className="rq-sec"><span className="rq-label"><span>Secret path</span></span>
                <input className="input mono" value={f.path ?? ""} onChange={set("path")} autoComplete="off" placeholder="servers/web01" /></label>
              <label className="rq-sec"><span className="rq-label"><span>KV mount <span className="t-muted rf-opt">(secret)</span></span></span>
                <input className="input mono" value={f.mount ?? ""} onChange={set("mount")} autoComplete="off" placeholder="secret" /></label>
              <label className="rq-sec"><span className="rq-label"><span>Field <span className="t-muted rf-opt">(password)</span></span></span>
                <input className="input mono" value={f.field ?? ""} onChange={set("field")} autoComplete="off" placeholder="password" /></label>
              <label className="rq-sec"><span className="rq-label"><span>Namespace <span className="t-muted rf-opt">(optional)</span></span></span>
                <input className="input mono" value={f.namespace ?? ""} onChange={set("namespace")} autoComplete="off" /></label>
              <div className="rq-sec"><span className="rq-label"><span>The connector signs in with</span></span>
                <div className="seg" role="radiogroup" aria-label="Sign-in method">
                  {([["token", "Token"], ["approle", "AppRole"]] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={f.auth === k} className={f.auth === k ? "seg-opt on" : "seg-opt"} onClick={() => setF((c) => ({ ...c, auth: k }))}>{l}</button>)}
                </div></div>
              <div className="rq-sec">
                <label className="rq-sec"><span className="rq-label"><span>KV version</span></span>
                  <div className="seg" role="radiogroup" aria-label="KV version">
                    {(["2", "1"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={f.kv === k} className={f.kv === k ? "seg-opt on" : "seg-opt"} onClick={() => setF((c) => ({ ...c, kv: k }))}>v{k}</button>)}
                  </div></label>
              </div>
              {f.auth === "approle" ? (
                <>
                  <label className="rq-sec"><span className="rq-label"><span>Role id</span></span>
                    <input className="input mono" value={f.roleId ?? ""} onChange={set("roleId")} autoComplete="off" /></label>
                  <label className="rq-sec"><span className="rq-label"><span>Secret id</span></span>
                    <input className="input mono" type="password" value={f.secretId ?? ""} onChange={set("secretId")} autoComplete="new-password" /></label>
                  <label className="rq-sec"><span className="rq-label"><span>AppRole mount <span className="t-muted rf-opt">(approle)</span></span></span>
                    <input className="input mono" value={f.authMount ?? ""} onChange={set("authMount")} autoComplete="off" placeholder="approle" /></label>
                </>
              ) : (
                <label className="rq-sec rot-wide"><span className="rq-label"><span>Token</span></span>
                  <input className="input mono" type="password" value={f.token ?? ""} onChange={set("token")} autoComplete="new-password" /></label>
              )}
            </>
          ) : (
            <>
              <label className="rq-sec"><span className="rq-label"><span>Application id</span></span>
                <input className="input mono" value={f.appId ?? ""} onChange={set("appId")} autoComplete="off" placeholder="Captivo" /></label>
              <label className="rq-sec"><span className="rq-label"><span>Safe</span></span>
                <input className="input mono" value={f.safe ?? ""} onChange={set("safe")} autoComplete="off" /></label>
              <label className="rq-sec"><span className="rq-label"><span>Object</span></span>
                <input className="input mono" value={f.object ?? ""} onChange={set("object")} autoComplete="off" placeholder="web01-admin" /></label>
              <label className="rq-sec"><span className="rq-label"><span>Folder <span className="t-muted rf-opt">(optional)</span></span></span>
                <input className="input mono" value={f.folder ?? ""} onChange={set("folder")} autoComplete="off" placeholder="Root" /></label>
              <label className="rq-sec rot-wide"><span className="rq-label"><span>Client certificate <span className="t-muted rf-opt">(PEM, if the provider asks for one)</span></span></span>
                <textarea className="textarea mono" rows={3} value={f.clientCert ?? ""} onChange={set("clientCert")} placeholder={"-----BEGIN CERTIFICATE-----"} spellCheck={false} /></label>
              <label className="rq-sec rot-wide"><span className="rq-label"><span>Its private key</span></span>
                <textarea className="textarea mono" rows={3} value={f.clientKey ?? ""} onChange={set("clientKey")} placeholder={"-----BEGIN PRIVATE KEY-----"} spellCheck={false} /></label>
            </>
          )}
          <div className="rq-sec rot-wide"><span className="rq-label"><span>The vault&apos;s certificate</span></span>
            <div className="seg" role="radiogroup" aria-label="Vault certificate">
              {([["system", "Public CA"], ["ca", "Our CA"], ["insecure", "Don't check"]] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={f.tls === k} className={f.tls === k ? "seg-opt on" : "seg-opt"} onClick={() => setF((c) => ({ ...c, tls: k }))}>{l}</button>)}
            </div>
            {f.tls === "ca" && <textarea className="textarea mono" rows={3} value={f.caPem ?? ""} onChange={set("caPem")} placeholder={"-----BEGIN CERTIFICATE-----\n(your CA)"} spellCheck={false} />}
          </div>
        </div>
      )}
    </div>
  );
}
