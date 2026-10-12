import { useEffect, useId, useRef, useState } from "react";
import { CircleAlert, Smartphone } from "lucide-react";
import type { HostAdapter, PairedPhone, PhoneInvite, PhoneStatus } from "./host";
import { ago } from "./sources";
import { useNow } from "./use-now";

/** The backend's refusal in its own words, which begin in lower case. */
function errorWords(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** The backend's refusal as a sentence of its own. */
function errorText(error: unknown) {
  const text = errorWords(error);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const day = (at: number) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(at));
const clock = (at: number) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(at));

/** Screen pixels per module: a whole number keeps every module the same size, which a camera reads best. */
const MODULE = 3;

/** The QR's dark modules as one path, with the four-module margin a camera needs around it. Faded once it has lapsed. */
function QrCode({ qr, lapsed }: { qr: PhoneInvite["qr"]; lapsed: boolean }) {
  const margin = 4;
  const size = qr.width + margin * 2;
  let path = "";
  qr.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "1") path += `M${x + margin} ${y + margin}h1v1h-1z`;
  });
  return <svg className={lapsed ? "phone-qr lapsed" : "phone-qr"} width={size * MODULE} height={size * MODULE} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label={lapsed ? "Lapsed pairing code" : "Pairing code"}><path d={path} /></svg>;
}

function PhoneRow({ phone, now, busy, onRevoke }: { phone: PairedPhone; now: number; busy: boolean; onRevoke: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const seen = phone.connected ? "Connected now" : phone.last_seen ? `Last seen ${ago(now - phone.last_seen)}` : "Not seen since pairing";
  return <li className="phone-row" data-testid="phone-row">
    <Smartphone size={17} className="phone-row-icon" />
    <div className="phone-row-text">
      <strong>{phone.name}</strong>
      <small>Paired {day(phone.paired_at)} <span aria-hidden="true">·</span> <span className={phone.connected ? "phone-connected" : undefined}>{seen}</span></small>
    </div>
    {confirming
      ? <div className="phone-confirm" role="group" aria-label={`Revoke ${phone.name}`}>
        <span>It is cut off at once.</span>
        <button type="button" className="btn-base phone-revoke-now" disabled={busy} onClick={onRevoke}>Revoke</button>
        <button type="button" className="routing-quiet" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>
      </div>
      : <button type="button" className="btn-base" disabled={busy} onClick={() => setConfirming(true)}>Revoke</button>}
  </li>;
}

/**
 * The captain's phone, in the settings: pairing starts here and only here, with a QR that works once and lapses in ten
 * minutes, and each paired phone can be revoked, which cuts it off before this answers. Everything is read and changed
 * through the backend's phone link (`src-tauri/src/phone/`), which keeps the keys; nothing secret stays in the window
 * once the code is closed.
 */
export function PhoneSettings({ host }: { host: HostAdapter }) {
  const [status, setStatus] = useState<PhoneStatus | null>(null);
  const [loadProblem, setLoadProblem] = useState<string | null>(null);
  const [invite, setInvite] = useState<PhoneInvite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const ids = useId();
  const now = useNow(invite ? 1000 : 30_000);
  const showing = useRef<PhoneInvite | null>(null);
  showing.current = invite;
  const known = useRef<PhoneStatus | null>(null);
  known.current = status;

  useEffect(() => {
    let live = true;
    host.phoneStatus().then((next) => live && setStatus(next), (problem) => live && setLoadProblem(errorWords(problem)));
    // A code nobody is looking at should not stay good.
    return () => {
      live = false;
      if (showing.current) void host.phoneInviteCancel().catch(() => undefined);
    };
  }, [host]);

  // Phones pairing, connecting and leaving, and a code going, as the link tells it.
  useEffect(() => host.onPhones((change) => {
    const added = change.phones.find((phone) => !known.current?.phones.some((before) => before.id === phone.id));
    setStatus((before) => before && { ...before, ...change });
    if (!showing.current) return;
    if (added) {
      setInvite(null);
      setNotice(`${added.name} is paired.`);
    } else if (change.invite_expires_at === null && showing.current.expires_at > Date.now()) {
      // Cancelled elsewhere, or spent by a phone this window did not see arrive.
      setInvite(null);
    }
  }), [host]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      setBusy(false);
    }
  };

  const pair = () => act(async () => {
    const next = await host.phoneInvite();
    setInvite(next);
    setStatus((before) => before && { ...before, invite_expires_at: next.expires_at });
  });
  const cancel = () => act(async () => {
    setStatus(await host.phoneInviteCancel());
    setInvite(null);
  });
  const revoke = (phone: PairedPhone) => act(async () => {
    setStatus(await host.phoneRevoke(phone.id));
    setNotice(`${phone.name} is revoked. It can't reach this Mac again unless you pair it anew.`);
  });

  const lapsed = invite !== null && invite.expires_at <= now;
  const phones = status?.phones ?? [];

  return <section className="phones" aria-labelledby={`${ids}-title`} data-testid="phones">
    <div className="phones-head">
      <h3 id={`${ids}-title`}>Your phone</h3>
      <p>Answer calls, read the page that argues one and send your review, and have a word with the first mate, from your phone. It reaches this Mac over your own Tailscale network, sealed end to end, and through nothing else.</p>
    </div>

    {loadProblem && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>The paired phones could not be read: {loadProblem}</span></div>}
    {status && !status.tailnet && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>This Mac is not on a Tailscale network, so no phone can reach it. Start Tailscale and sign in, then pair your phone.</span></div>}

    {status && (phones.length > 0
      ? <ul className="phone-list">{phones.map((phone) => <PhoneRow key={phone.id} phone={phone} now={now} busy={busy} onRevoke={() => void revoke(phone)} />)}</ul>
      : !invite && <p className="phones-none">No phone is paired with this Mac.</p>)}

    {invite && <div className="phone-invite" data-testid="phone-invite">
      <QrCode qr={invite.qr} lapsed={lapsed} />
      <div className="phone-invite-text">
        <strong>Scan this with Quarterdeck on your phone</strong>
        <p>Your phone needs Tailscale, signed in to the same network as this Mac.</p>
        <p>A paired phone can ask the first mate for anything you could ask in chat. Revoke takes that back.</p>
        <p className={lapsed ? "phone-lapsed" : undefined}>{lapsed ? "This code has lapsed. Show a new one to pair." : `It works once, until ${clock(invite.expires_at)}.`}</p>
        <div className="routing-actions">
          {lapsed && <button type="button" className="routing-primary" disabled={busy} onClick={() => void pair()}>Show a new code</button>}
          <button type="button" className="routing-quiet" disabled={busy} onClick={() => void cancel()}>{lapsed ? "Close" : "Cancel"}</button>
        </div>
      </div>
    </div>}

    {error && <div className="routing-alert" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {notice && <p className="routing-notice" role="status">{notice}</p>}

    {status && !invite && <button type="button" className="routing-primary" disabled={busy || !status.tailnet} onClick={() => void pair()}>{phones.length > 0 ? "Pair another phone" : "Pair a phone"}</button>}
  </section>;
}
