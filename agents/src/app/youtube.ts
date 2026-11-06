/**
 * Linking a creator's YouTube channel (optional; never required to list) and the "Face matches channel" badge.
 *
 * Not a sign-in: a signed-in creator runs a standalone Google OAuth flow, once, for the youtube.readonly scope only.
 * Our backend is the confidential client (code flow, PKCE S256, a single-use state kept server-side). The access token
 * is checked to have been issued to our client with that scope, used to read the channel of the Google account that
 * granted it (channels.list mine=true) and its recent uploads, and then dropped: never stored, never sent to the
 * browser. Kept: the channel id, title, picture, subscriber count, topics, and the public image URLs.
 *
 * The face match: the profile picture and up to 5 recent video thumbnails, against the creator's live capture. The
 * badge needs at least 2 images with a matching face (CONSENT_FACE_MATCH_THRESHOLD). A faceless channel gets no badge
 * and is never blocked. Limits: thumbnails are noisy (other people, graphics), and while the Google consent screen is
 * in testing mode, Google shows its "unverified app" warning.
 */
import type { Accounts, CreatorRow, OidcAttempt } from "./accounts.js";
import { pkce, randomToken } from "./worldid.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const TOKENINFO = "https://oauth2.googleapis.com/tokeninfo";
const API = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const MAX_IMAGE_BYTES = 5 << 20;

export type LinkOutcome = "linked" | "cancelled" | "failed" | "taken" | "no-channel";

export interface ChannelFace {
  checkedAt: number;
  images: number; // images fetched
  withFace: number; // images with a face in them
  matches: number; // images whose face matches the capture
  best: number | null;
  badge: boolean;
}

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: () => string;
  fetch?: typeof fetch;
}

/**
 * Google's redirect for channel linking: the path registered on the OAuth client, a legacy path (/api/likeness/…, an
 * alias of /api/facevisa/…) until /api/facevisa/youtube/callback is added there; then set YOUTUBE_REDIRECT_URI, or
 * change this.
 */
export const YOUTUBE_CALLBACK = "/api/likeness/youtube/callback";

export function youtubeConfigFromEnv(publicUrl: string): YouTubeConfig | undefined {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret, redirectUri: () => process.env.YOUTUBE_REDIRECT_URI || `${publicUrl}${YOUTUBE_CALLBACK}` };
}

/** Scores per image (the best face against the capture; null when the image has no face), or undefined when no check can run. */
export type ChannelMatcher = (uid: string, images: Uint8Array[]) => Promise<(number | null)[] | undefined>;

export const parseFace = (row: CreatorRow | undefined): ChannelFace | null => (row?.youtubeFace ? (JSON.parse(row.youtubeFace) as ChannelFace) : null);
export const parseTopics = (row: CreatorRow | undefined): string[] => (row?.youtubeTopics ? (JSON.parse(row.youtubeTopics) as string[]) : []);

export class YouTubeLink {
  private readonly fetchFn: typeof fetch;
  constructor(
    readonly c: YouTubeConfig,
    private readonly d: { accounts: Accounts; match: ChannelMatcher; threshold: () => number },
  ) {
    this.fetchFn = c.fetch ?? fetch;
  }

  /** The Google authorization URL for this creator: youtube.readonly only, online access (no refresh token). */
  start(uid: string): string {
    const state = randomToken();
    const { verifier, challenge } = pkce();
    this.d.accounts.createAttempt({ state, purpose: "youtube", nonce: randomToken(), verifier, ttlMs: 10 * 60_000, redirectUri: this.c.redirectUri(), uid });
    const u = new URL(AUTH);
    u.search = new URLSearchParams({
      client_id: this.c.clientId,
      redirect_uri: this.c.redirectUri(),
      response_type: "code",
      scope: YOUTUBE_SCOPE,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "online",
      include_granted_scopes: "false",
      prompt: "select_account",
    }).toString();
    return u.toString();
  }

  private async json<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; body: T }> {
    const r = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { ok: r.ok, body: (await r.json().catch(() => ({}))) as T };
  }

  /** The callback for a YouTube attempt (taken once by its state). The token is used here and then dropped. */
  async callback(attempt: OidcAttempt, q: URLSearchParams): Promise<LinkOutcome> {
    if (attempt.purpose !== "youtube" || !attempt.uid) return "failed";
    if (q.get("error")) return q.get("error") === "access_denied" ? "cancelled" : "failed";
    const code = q.get("code");
    if (!code) return "failed";
    const tok = await this.json<{ access_token?: string; scope?: string }>(TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: attempt.redirectUri ?? this.c.redirectUri(), code_verifier: attempt.verifier, client_id: this.c.clientId, client_secret: this.c.clientSecret }).toString(),
    });
    const token = tok.body.access_token;
    if (!tok.ok || !token) return "failed";
    const auth = { headers: { authorization: `Bearer ${token}` } };
    // The token must be one Google issued to our client, with exactly the read-only YouTube scope we asked for.
    const info = await this.json<{ aud?: string; azp?: string; scope?: string }>(`${TOKENINFO}?access_token=${encodeURIComponent(token)}`);
    if (!info.ok || (info.body.aud !== this.c.clientId && info.body.azp !== this.c.clientId) || !info.body.scope?.split(" ").includes(YOUTUBE_SCOPE)) return "failed";
    // mine=true: the channel of the Google account that granted the token, not one the browser names.
    const ch = await this.json<{ items?: { id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> }; statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean }; topicDetails?: { topicCategories?: string[] }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }[] }>(
      `${API}/channels?part=snippet,statistics,topicDetails,contentDetails&mine=true`,
      auth,
    );
    const channel = ch.body.items?.[0];
    if (!ch.ok) return "failed";
    if (!channel) return "no-channel";
    const other = this.d.accounts.creatorByChannel(channel.id);
    if (other && other.uid !== attempt.uid) return "taken";
    const pic = channel.snippet?.thumbnails ?? {};
    const picture = pic.high?.url ?? pic.medium?.url ?? pic.default?.url ?? null;
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    const thumbs: string[] = [];
    if (uploads) {
      const pl = await this.json<{ items?: { snippet?: { thumbnails?: Record<string, { url?: string }> } }[] }>(`${API}/playlistItems?part=snippet&maxResults=5&playlistId=${encodeURIComponent(uploads)}`, auth);
      for (const it of pl.body.items ?? []) {
        const t = it.snippet?.thumbnails ?? {};
        const url = t.maxres?.url ?? t.standard?.url ?? t.high?.url ?? t.medium?.url;
        if (url) thumbs.push(url);
      }
    }
    const topics = (channel.topicDetails?.topicCategories ?? []).map((u) => decodeURIComponent(u.split("/").pop() ?? "").replace(/_/g, " ")).filter(Boolean);
    const subscribers = channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount ?? NaN);
    this.d.accounts.updateCreator(attempt.uid, {
      youtubeChannelId: channel.id,
      youtubeTitle: channel.snippet?.title ?? channel.id,
      youtubeThumbnail: picture,
      youtubeVerifiedAt: Date.now(),
      youtubeSubscribers: Number.isFinite(subscribers) ? subscribers : null,
      youtubeTopics: JSON.stringify(topics),
      youtubeImages: JSON.stringify([picture, ...thumbs].filter(Boolean)),
      youtubeFace: null,
    });
    void this.faceMatch(attempt.uid).catch(() => undefined);
    return "linked";
  }

  /** (Re)runs the channel face match: on linking, and after a new live capture. No capture or no models: nothing to do. */
  async faceMatch(uid: string): Promise<ChannelFace | undefined> {
    const row = this.d.accounts.creator(uid);
    const urls = row?.youtubeImages ? (JSON.parse(row.youtubeImages) as string[]) : [];
    if (!row?.captureFiles || !urls.length) return undefined;
    const images: Uint8Array[] = [];
    for (const url of urls.slice(0, 6)) {
      try {
        const r = await this.fetchFn(url, { signal: AbortSignal.timeout(15_000) });
        const b = new Uint8Array(await r.arrayBuffer());
        if (r.ok && b.length && b.length <= MAX_IMAGE_BYTES) images.push(b);
      } catch {
        // an image that can't be fetched just isn't counted
      }
    }
    const scores = await this.d.match(uid, images);
    if (!scores) return undefined;
    const t = this.d.threshold();
    const withFace = scores.filter((s) => s !== null) as number[];
    const matches = withFace.filter((s) => s >= t).length;
    const face: ChannelFace = { checkedAt: Date.now(), images: images.length, withFace: withFace.length, matches, best: withFace.length ? Math.max(...withFace) : null, badge: matches >= 2 };
    this.d.accounts.updateCreator(uid, { youtubeFace: JSON.stringify(face) });
    return face;
  }

  unlink(uid: string) {
    this.d.accounts.updateCreator(uid, { youtubeChannelId: null, youtubeTitle: null, youtubeThumbnail: null, youtubeVerifiedAt: null, youtubeSubscribers: null, youtubeTopics: null, youtubeImages: null, youtubeFace: null });
  }
}
