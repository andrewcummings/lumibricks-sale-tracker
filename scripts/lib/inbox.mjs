// Read a dedicated mailbox for newly-arrived discount codes — the highest-yield
// source for off-site exclusives (Instagram/email-only codes that never touch the
// storefront, e.g. BESTDEAL15). We subscribe a throwaway inbox to the store's
// newsletter and skim each unread message for code tokens, which then flow into
// the same cart-probe validator as homepage/seed candidates (codes.mjs).
//
// Zero-dependency by design (the whole repo is): a minimal IMAP-over-TLS client
// on node:tls rather than an npm IMAP library. We never parse MIME — marketing
// mail is multipart HTML and we only need to regex codes out of it, so we run
// extractCodes() over the raw RFC822 bytes of each message.
//
// Security: credentials come ONLY from env (GitHub Actions secrets); nothing but
// extracted code tokens is ever returned/persisted — no bodies, addresses, or
// headers. A sender allowlist (IMAP_FROM) keeps unrelated mail out. With no
// IMAP_USER/IMAP_PASS set it no-ops (returns []), like the Amazon scripts.

import tls from "node:tls";
import { extractCodes } from "./codes.mjs";

// Email bodies aren't plain text like the homepage: marketing HTML wraps codes
// in tags (`<strong>SUMMER20</strong>`) and quoted-printable encoding splits
// words across soft line breaks (`SUMM=\r\nER20`). Flatten both so the same
// trigger→code regex that works on the homepage works here. We don't fully parse
// MIME — base64-only parts are a known gap (most ESPs send quoted-printable
// HTML); the cart probe is still the final filter.
function flatten(raw) {
  return String(raw || "")
    .replace(/=\r?\n/g, "") // QP soft line breaks
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) // QP hex octets
    .replace(/<[^>]+>/g, " ") // strip HTML tags
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&");
}

// Extract code tokens from a raw RFC822 email message. Exported for unit tests.
export function extractEmailCodes(raw) {
  return extractCodes(flatten(raw));
}

// IMAP literals look like `…{123}\r\n<123 octets>`. To know when a tagged
// response is complete we must scan line-by-line BUT skip literal octets (they
// can contain anything, including text that looks like a tag). Returns the byte
// index just past the tagged completion line, or -1 if more data is needed.
export function taggedEnd(buf, tag) { // exported for unit tests
  const tagPrefix = Buffer.from(tag + " ");
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf("\r\n", pos, "latin1");
    if (nl === -1) return -1; // incomplete line
    const line = buf.slice(pos, nl); // text of this line (no CRLF)
    let after = nl + 2;
    const lit = /\{(\d+)\}$/.exec(line.toString("latin1"));
    if (lit) {
      after += Number(lit[1]); // skip the literal's octets, then keep scanning
      if (after > buf.length) return -1; // literal not fully received yet
      pos = after;
      continue;
    }
    if (line.length >= tagPrefix.length && line.slice(0, tagPrefix.length).equals(tagPrefix)) {
      return after; // tagged completion line — response is whole
    }
    pos = after;
  }
  return -1;
}

// Resolve once `predicate(buf)` returns an end index >= 0, handing back that
// slice as a string and leaving the remainder buffered for the next read.
function readUntil(state, predicate) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      state.active = null;
      state.sock.off("error", onErr);
      state.sock.off("close", onClose);
      clearTimeout(timer);
    };
    const onErr = (e) => { finish(); reject(e); };
    const onClose = () => { finish(); reject(new Error("connection closed")); };
    const timer = setTimeout(() => { finish(); reject(new Error("timeout")); }, state.timeoutMs);
    const check = () => {
      const end = predicate(state.buf);
      if (end >= 0) {
        const out = state.buf.slice(0, end).toString("latin1");
        state.buf = state.buf.slice(end);
        finish();
        resolve(out);
      }
    };
    state.active = check;
    state.sock.on("error", onErr);
    state.sock.on("close", onClose);
    check(); // data may already be buffered
  });
}

let tagSeq = 0;
async function cmd(state, command, { secret = false } = {}) {
  const tag = `a${++tagSeq}`;
  state.sock.write(`${tag} ${command}\r\n`);
  const resp = await readUntil(state, (buf) => taggedEnd(buf, tag));
  const last = resp.trimEnd().split("\r\n").pop() || "";
  if (!new RegExp(`^${tag} OK`, "i").test(last)) {
    // Never echo the command on failure — it may contain the password.
    throw new Error(secret ? "command rejected" : `"${command.split(" ")[0]}" rejected: ${last}`);
  }
  return resp;
}

const quote = (s) => `"${String(s).replace(/([\\"])/g, "\\$1")}"`;

// Returns { ok, codes, count, skipped?, error? }. Best-effort: any failure
// yields ok:false with codes:[] so the caller continues on other sources.
export async function readInboxCodes({ timeoutMs = 20000, maxMessages = 25 } = {}) {
  const user = process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;
  if (!user || !pass) return { ok: true, codes: [], count: 0, skipped: true };

  const host = process.env.IMAP_HOST || "imap.gmail.com";
  const port = Number(process.env.IMAP_PORT) || 993;
  const fromFilter = process.env.IMAP_FROM || "lumibricks"; // matches From header (incl. display name)

  let state;
  try {
    const sock = await new Promise((resolve, reject) => {
      const s = tls.connect({ host, port, servername: host }, () => resolve(s));
      s.once("error", reject);
      s.setTimeout(timeoutMs, () => s.destroy(new Error("connect timeout")));
    });
    sock.setTimeout(0);
    state = { sock, buf: Buffer.alloc(0), timeoutMs, active: null };
    sock.on("data", (d) => {
      state.buf = Buffer.concat([state.buf, d]);
      if (state.active) state.active();
    });

    await readUntil(state, (buf) => taggedEnd(buf, "*")); // server greeting (`* OK …`)
    await cmd(state, `LOGIN ${quote(user)} ${quote(pass)}`, { secret: true });
    await cmd(state, "SELECT INBOX");

    // Unread mail from the store only. IMAP SEARCH FROM is a case-insensitive
    // substring over the From header, so "lumibricks" matches the display name
    // even if the ESP sends from another domain.
    const search = await cmd(state, `UID SEARCH UNSEEN FROM ${quote(fromFilter)}`);
    const line = search.split("\r\n").find((l) => /^\* SEARCH/i.test(l)) || "";
    let uids = (line.match(/\d+/g) || []).map(Number);
    if (uids.length === 0) {
      await cmd(state, "LOGOUT").catch(() => {});
      return { ok: true, codes: [], count: 0 };
    }
    if (uids.length > maxMessages) uids = uids.slice(-maxMessages); // newest N

    // PEEK = don't auto-set \Seen; we mark them read explicitly only after a
    // successful read, so a mid-run failure leaves them to be retried next time.
    const fetched = await cmd(state, `UID FETCH ${uids.join(",")} BODY.PEEK[]`);
    const codes = extractEmailCodes(fetched);
    await cmd(state, `UID STORE ${uids.join(",")} +FLAGS (\\Seen)`).catch(() => {});
    await cmd(state, "LOGOUT").catch(() => {});

    return { ok: true, codes, count: uids.length };
  } catch (err) {
    return { ok: false, codes: [], count: 0, error: String(err?.message || err) };
  } finally {
    try { state?.sock?.destroy(); } catch { /* ignore */ }
  }
}
