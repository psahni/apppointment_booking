"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestPatientAuth } from "@/modules/identity/client";

type Demo = { accounts: { email: string; name: string }[]; code: string };

export function PatientLoginForm({ destination = "/appointments", demo }: { destination?: "/book" | "/appointments"; demo?: Demo }) {
  const router = useRouter();
  const [email, setEmail] = useState(demo?.accounts[0]?.email ?? "");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [pending, setPending] = useState<"request" | "verify" | null>(null);
  const [error, setError] = useState("");
  const codeInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (step === "code" && !pending) codeInput.current?.focus(); }, [step, pending]);

  async function submit(method: "request" | "verify") {
    if (pending) return;
    const address = email.trim().toLowerCase(); setError("");
    if (!z.email().safeParse(address).success) { setError("Enter a valid email address."); return; }
    if (method === "verify" && !/^(\d{4}|\d{6})$/.test(code)) { setError("Enter your sign-in code."); return; }
    setPending(method);
    try {
      if (method === "request") {
        await requestPatientAuth("email-otp/send-verification-otp", { email: address, type: "sign-in" });
        setEmail(address); setCode(""); setStep("code");
      } else {
        await requestPatientAuth("sign-in/email-otp", { email: address, otp: code });
        router.replace(destination); router.refresh();
      }
    } catch (failure) {
      setError(failure instanceof Error && failure.message !== "Failed to fetch" ? failure.message : "Unable to connect. Please try again.");
    } finally { setPending(null); }
  }
  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(step === "email" ? "request" : "verify"); }
  return <form onSubmit={onSubmit} noValidate aria-busy={!!pending} className="space-y-5">
    <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 text-xs font-medium"><Mail aria-hidden="true" className="size-3.5 text-primary" />{demo ? "Maple Clinic patient demo" : "Patient email-code sign-in"}</div>
    {demo && <p className="text-sm text-muted-foreground">Demo code <strong className="font-mono text-foreground">{demo.code}</strong></p>}
    {step === "email" ? <div><label htmlFor="patient-email" className="text-sm font-medium">{demo ? "Demo patient" : "Email"}</label>{demo
      ? <select id="patient-email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!!pending} className="ui-input">{demo.accounts.map((account) => <option key={account.email} value={account.email}>{account.name} ({account.email})</option>)}</select>
      : <input id="patient-email" name="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} disabled={!!pending} className="ui-input" />}</div>
      : <><p role="status" className="break-words text-sm leading-relaxed text-muted-foreground">Enter the sign-in code for<br /><span className="font-medium text-foreground">{email}</span></p><div><label htmlFor="patient-code" className="text-sm font-medium">Code</label><input ref={codeInput} id="patient-code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} disabled={!!pending} className="ui-input" /></div></>}
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    <Button type="submit" disabled={!!pending} className="w-full">{pending === "request" ? "Requesting code…" : pending === "verify" ? "Signing in…" : step === "email" ? (demo ? "Continue" : "Send code") : "Sign in"}</Button>
    {step === "code" && <div className="flex flex-wrap items-center justify-between gap-3 text-xs"><button type="button" disabled={!!pending} onClick={() => { setStep("email"); setCode(""); setError(""); }} className="rounded text-primary underline-offset-4 hover:underline disabled:opacity-50">Use another email</button><button type="button" disabled={!!pending} onClick={() => void submit("request")} className="rounded font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50">Request new code</button></div>}
  </form>;
}
