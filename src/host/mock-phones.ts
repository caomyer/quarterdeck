import invite from "../fixtures/phone-invite.json";
import type { PairedPhone, PhoneChange, PhoneInvite, PhoneStatus } from "@quarterdeck/core/types";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LIFETIME = 10 * MINUTE;

/**
 * The phone link, as `src-tauri/src/phone/` keeps it, for the browser mock. `?phones=<state>`: `paired` has one phone
 * paired and connected and one last seen days ago, `offline` is a Mac with a paired phone that is not on a Tailscale
 * network, `nontailnet` is one with no phone that is not on one either, `broken` cannot read its phone list,
 * `scans` pairs a phone a moment after an invite is shown, as scanning it does, and `leaves` is `paired` with the
 * connected phone leaving a moment after the list is read. Otherwise no phone is paired.
 *
 * Every change is told to `listen`ers as the backend's `phones` event tells the window.
 *
 * The invite's QR is a real one the Mac drew (`src/fixtures/phone-invite.json`, pinned by the backend's tests).
 */
export class MockPhones {
  private readonly scenario = new URLSearchParams(window.location.search).get("phones");
  private phones: PairedPhone[];
  private inviteExpires: number | null = null;
  private readonly listeners = new Set<(change: PhoneChange) => void>();

  constructor() {
    const now = Date.now();
    this.phones = this.scenario === "paired" || this.scenario === "leaves" || this.scenario === "offline"
      ? [
        { id: "5f0c9a2e81d4b7c3", name: "Captain's iPhone", paired_at: now - 9 * DAY, last_seen: now - 2 * MINUTE, connected: this.scenario !== "offline" },
        { id: "a17e44d0c2b9f865", name: "Old iPhone 12", paired_at: now - 120 * DAY, last_seen: now - 23 * DAY, connected: false },
      ]
      : [];
  }

  private tailnet() {
    return this.scenario !== "offline" && this.scenario !== "nontailnet";
  }

  private status(): PhoneStatus {
    if (this.inviteExpires !== null && this.inviteExpires <= Date.now()) this.inviteExpires = null;
    const wanted = this.tailnet() && (this.phones.length > 0 || this.inviteExpires !== null);
    return { phones: structuredClone(this.phones), invite_expires_at: this.inviteExpires, listening: wanted ? ["100.101.102.103:47319"] : [], tailnet: this.tailnet() };
  }

  listen(listener: (change: PhoneChange) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private changed() {
    const { phones, invite_expires_at } = this.status();
    this.listeners.forEach((listener) => listener({ phones, invite_expires_at }));
  }

  async get(): Promise<PhoneStatus> {
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    if (this.scenario === "broken") throw new Error("the phone link is not available: ~/Library/Application Support/dev.firstmate.desktop/phone/mac.key cannot be read, so no phone can reach this Mac");
    if (this.scenario === "leaves") {
      window.setTimeout(() => {
        const left = this.phones.find((phone) => phone.connected);
        if (!left) return;
        left.connected = false;
        left.last_seen = Date.now();
        this.changed();
      }, 2500);
    }
    return this.status();
  }

  async invite(): Promise<PhoneInvite> {
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    if (!this.tailnet()) throw new Error("this Mac is not on a Tailscale network; start Tailscale and sign in, then pair");
    const expires = Date.now() + LIFETIME;
    this.inviteExpires = expires;
    if (this.scenario === "scans") {
      window.setTimeout(() => {
        if (this.inviteExpires !== expires) return;
        const now = Date.now();
        this.inviteExpires = null;
        this.phones.push({ id: "c3d9e1f07a2b5486", name: "Captain's iPhone", paired_at: now, last_seen: now, connected: true });
        this.changed();
      }, 2500);
    }
    this.changed();
    return { expires_at: expires, offer: { ...invite.offer, expires }, qr: invite.qr };
  }

  async cancel(): Promise<PhoneStatus> {
    this.inviteExpires = null;
    this.changed();
    return this.status();
  }

  async revoke(id: string): Promise<PhoneStatus> {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    if (!this.phones.some((phone) => phone.id === id)) throw new Error("that phone is not paired with this Mac");
    this.phones = this.phones.filter((phone) => phone.id !== id);
    this.changed();
    return this.status();
  }
}
