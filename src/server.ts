import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type RuntimeEnv = Record<string, string | undefined>;

// Stateless signed token helpers using standard Web Crypto API
async function signStateToken(email: string, token: string, expiresAt: number, secret: string) {
  const payload = btoa(JSON.stringify({ email, token, expiresAt }));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const signature = Array.from(new Uint8Array(signatureBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${signature}`;
}

async function verifyStateToken(stateToken: string, secret: string) {
  const [payload, signature] = stateToken.split(".");
  if (!payload || !signature) return null;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expectedSignatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedSignature = Array.from(new Uint8Array(expectedSignatureBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expectedSignature !== signature) return null;
  try { return JSON.parse(atob(payload)); } catch { return null; }
}

async function readLocalDotEnv(): Promise<RuntimeEnv> {
  if (typeof process === "undefined" || !process.versions?.node) return {};

  try {
    const [{ readFile }, { join }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
    const text = await readFile(join(process.cwd(), ".env"), "utf8");
    return text.split(/\r?\n/).reduce<RuntimeEnv>((acc, line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return acc;
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) return acc;
      const key = trimmed.slice(0, separatorIndex).trim().replace(/\s+/g, "_");
      const value = trimmed.slice(separatorIndex + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
  } catch {
    return {};
  }
}

async function getRuntimeEnv(env: unknown): Promise<RuntimeEnv> {
  return {
    ...(await readLocalDotEnv()),
    ...(typeof process !== "undefined" ? process.env : {}),
    ...(env && typeof env === "object" ? env as RuntimeEnv : {}),
  };
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers ?? {}),
    },
  });
}

async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getEmailHtml(token: string, isRecovery: boolean) {
  const title = isRecovery ? "VTAB Square password reset" : "VTAB Square verification code";
  const desc = isRecovery ? "Use this code to reset your password:" : "Use this code to complete your signup:";
  return `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827"><h2>${title}</h2><p>${desc}</p><div style="font-size:28px;font-weight:700;letter-spacing:6px;margin:24px 0">${token}</div><p>This code expires in 10 minutes.</p></div>`;
}

async function sendOtpEmail(runtimeEnv: RuntimeEnv, email: string, token: string, isRecovery: boolean = false) {
  const fromEmail = runtimeEnv.AUTH_EMAIL_FROM;
  const fromName = runtimeEnv.AUTH_EMAIL_FROM_NAME || "VTAB Square";
  const brevoApiKey = runtimeEnv.BREVO_API_KEY;
  const resendApiKey = runtimeEnv.RESEND_API_KEY;
  const subject = isRecovery ? "Your VTAB Square password reset code" : "Your VTAB Square signup code";
  const textContent = isRecovery 
    ? `Your VTAB Square password reset code is ${token}. It expires in 10 minutes.`
    : `Your VTAB Square signup code is ${token}. It expires in 10 minutes.`;

  if (!fromEmail) throw new Error("AUTH_EMAIL_FROM is not configured.");

  if (brevoApiKey) {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "accept": "application/json", "api-key": brevoApiKey, "content-type": "application/json" },
      body: JSON.stringify({
        sender: { email: fromEmail, name: fromName },
        to: [{ email }],
        subject,
        htmlContent: getEmailHtml(token, isRecovery),
        textContent,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return;
  }

  if (resendApiKey) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "authorization": `Bearer ${resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: `${fromName} <${fromEmail}>`,
        to: [email],
        subject,
        html: getEmailHtml(token, isRecovery),
        text: textContent,
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return;
  }

  throw new Error("Configure BREVO_API_KEY or RESEND_API_KEY.");
}

async function handleSendSignupOtp(request: Request, runtimeEnv: RuntimeEnv) {
  const body = await readJsonBody(request);
  const email = normalizeEmail(body && typeof body === "object" ? (body as { email?: unknown }).email : undefined);

  if (!email || !email.includes("@")) return jsonResponse({ error: "Enter a valid email address." }, { status: 400 });

  const serviceRoleKey = runtimeEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return jsonResponse({ error: "Server misconfiguration. Cannot generate secure token." }, { status: 500 });

  const token = generateOtp();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const stateToken = await signStateToken(email, token, expiresAt, serviceRoleKey);
  
  await sendOtpEmail(runtimeEnv, email, token, false);
  return jsonResponse({ ok: true, stateToken });
}

async function handleSendRecoveryOtp(request: Request, runtimeEnv: RuntimeEnv) {
  const body = await readJsonBody(request);
  const email = normalizeEmail(body && typeof body === "object" ? (body as { email?: unknown }).email : undefined);

  if (!email || !email.includes("@")) return jsonResponse({ error: "Enter a valid email address." }, { status: 400 });

  const supabaseUrl = runtimeEnv.SUPABASE_URL || runtimeEnv.VITE_SUPABASE_URL;
  const serviceRoleKey = runtimeEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Server misconfiguration." }, { status: 500 });

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "authorization": `Bearer ${serviceRoleKey}`, "apikey": serviceRoleKey, "content-type": "application/json" },
    body: JSON.stringify({ type: "recovery", email }),
  });

  if (!response.ok) {
    // If user doesn't exist, we swallow it to prevent email enumeration, exactly as Supabase does.
    if (response.status === 404) return jsonResponse({ ok: true }); 
    throw new Error(await response.text() || "Could not generate recovery link.");
  }

  const data = await response.json();
  const token = data.email_otp;
  if (!token) throw new Error("No OTP returned from Supabase.");

  await sendOtpEmail(runtimeEnv, email, token, true);
  return jsonResponse({ ok: true });
}

async function createConfirmedSupabaseUser(runtimeEnv: RuntimeEnv, email: string, password: string) {
  const supabaseUrl = runtimeEnv.SUPABASE_URL || runtimeEnv.VITE_SUPABASE_URL;
  const serviceRoleKey = runtimeEnv.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl) throw new Error("SUPABASE_URL or VITE_SUPABASE_URL is not configured.");
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");

  const response = await fetch(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${serviceRoleKey}`,
      "apikey": serviceRoleKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });

  if (response.ok) return;

  const text = await response.text();
  if (response.status === 422 && /already|registered|exists/i.test(text)) {
    throw new Error("An account with this email already exists.");
  }
  throw new Error(text || "Could not create user.");
}

async function handleVerifySignupOtp(request: Request, runtimeEnv: RuntimeEnv) {
  const body = await readJsonBody(request);
  const payload = body && typeof body === "object" ? body as { email?: unknown; password?: unknown; token?: unknown; stateToken?: unknown } : {};
  const email = normalizeEmail(payload.email);
  const password = typeof payload.password === "string" ? payload.password : "";
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  const stateToken = typeof payload.stateToken === "string" ? payload.stateToken : "";
  
  const serviceRoleKey = runtimeEnv.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) return jsonResponse({ error: "Server misconfiguration." }, { status: 500 });

  if (!email || !password || !token || !stateToken) return jsonResponse({ error: "Email, password, and verification code are required." }, { status: 400 });
  if (password.length < 6) return jsonResponse({ error: "Password must be at least 6 characters." }, { status: 400 });
  
  const record = await verifyStateToken(stateToken, serviceRoleKey);
  if (!record || record.email !== email || record.expiresAt < Date.now()) return jsonResponse({ error: "Verification code expired or invalid. Please request a new one." }, { status: 400 });
  if (record.token !== token) return jsonResponse({ error: "Invalid verification code." }, { status: 400 });

  await createConfirmedSupabaseUser(runtimeEnv, email, password);
  return jsonResponse({ ok: true });
}

export async function handleAuthApiRequest(request: Request, runtimeEnv: RuntimeEnv) {
  try {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/auth/")) return null;
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    if (url.pathname === "/api/auth/signup/send-otp") return await handleSendSignupOtp(request, runtimeEnv);
    if (url.pathname === "/api/auth/signup/verify") return await handleVerifySignupOtp(request, runtimeEnv);
    if (url.pathname === "/api/auth/recovery/send-otp") return await handleSendRecoveryOtp(request, runtimeEnv);
    
    return new Response("Not found", { status: 404 });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Authentication request failed.";
    return jsonResponse({ error: message }, { status: 500 });
  }
}

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ─── Security headers applied to every response ──────────────────────────────
function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  // Prevent MIME-type sniffing
  headers.set("X-Content-Type-Options", "nosniff");

  // Clickjacking protection
  headers.set("X-Frame-Options", "DENY");

  // Force HTTPS for 1 year, include subdomains
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  // Limit referrer leakage
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Disable unnecessary browser features
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  // Content Security Policy
  // - default-src 'self': only load resources from our own origin
  // - script-src 'self' 'unsafe-inline': React needs inline scripts
  // - style-src 'self' 'unsafe-inline' fonts.googleapis.com: allow Google Fonts styles
  // - font-src 'self' fonts.gstatic.com: allow Google Fonts files
  // - img-src 'self' data: blob:: allow inline images and blob URLs
  // - connect-src 'self' *.supabase.co api.brevo.com generativelanguage.googleapis.com: allow Supabase + Brevo + Gemini API calls
  // - frame-ancestors 'none': no embedding in iframes (stronger than X-Frame-Options)
  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: blob:",
      "connect-src 'self' https://*.supabase.co https://api.brevo.com https://generativelanguage.googleapis.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const runtimeEnv = await getRuntimeEnv(env);
      const authApiResponse = await handleAuthApiRequest(request, runtimeEnv);
      if (authApiResponse) return applySecurityHeaders(authApiResponse);

      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      return applySecurityHeaders(normalized);
    } catch (error) {
      console.error(error);
      return applySecurityHeaders(
        new Response(renderErrorPage(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      );
    }
  },
};

