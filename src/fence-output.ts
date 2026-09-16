//
// get_transcript hands the agent third-party text — a YouTube video's captions, written
// by an arbitrary uploader (or a lossy ASR model for auto-captions). That is exactly the
// channel a prompt injection rides in on: untrusted data wearing a trusted sender. Before
// it reaches the privileged agent we frame it structurally as DATA, fenced with a nonce
// the uploader never saw, and neutralize any fence-boundary-shaped tags the captions
// smuggled. Same SHARED pure lib + same pattern as web-fetch-cartridge — the only
// youtube-specific bit is the provenance we surface (videoId, lang, auto-caption warning,
// title, sanitize report), threaded into the fence header.

import { fenceUntrusted, scanForgeries, mintNonce, sanitizeText, type SanitizeReport } from "@agentruntime/untrusted-fence";

/** YouTube-specific provenance surfaced in the fence header (honesty, never silent). */
export interface YoutubeProvenance {
  /** Resolved caption language code, e.g. "en". */
  lang: string;
  /** true = auto-generated (machine ASR, lossy); false = creator-authored. */
  auto: boolean;
  /** Best-effort video title (omitted from the header when absent). */
  title?: string;
  /** What the mechanical sanitizer stripped (surfaced, never hidden). */
  sanitize: SanitizeReport;
}

/** Result of fencing one transcript blob. */
export interface FenceContentResult {
  /** The full fenced envelope (header + <untrusted-{nonce}> … </untrusted-{nonce}>). */
  fenced: string;
  /** Per-call nonce used as the fence delimiter key (hex, 32 chars). */
  nonce: string;
  /** Count of boundary-forgery attempts found + neutralized in the content. */
  forgeries: number;
}

/**
 * Clean an UNTRUSTED single-line header/provenance field (e.g. the uploader-controlled
 * video title) before it is spliced into the fence header — which sits ABOVE the fenced
 * body, OUTSIDE what fenceUntrusted's internal oneLine() guards. Without this the title
 * could (a) carry invisible / bidi / Tags-block chars the body sanitizer never sees, or
 * (b) forge an extra header line via a unicode line separator (LS/PS U+2028/2029 survive
 * fetchTitle's \r\n first-line split). sanitizeText strips the hidden chars; the replace
 * collapses any remaining line-structure (incl. tab) to a space — visible, never silently
 * dropped (Honest-Response).
 */
function cleanHeaderField(value: string): string {
  return sanitizeText(value).text.replace(/[\r\n\t\u2028\u2029]/g, " ");
}

/**
 * Wrap an untrusted transcript in the nonce-keyed untrusted-data fence.
 *
 * Pure and side-effect free (apart from minting a random nonce) so it is unit-testable
 * without a live yt-dlp fetch. `source` carries provenance into the fence header
 * (e.g. `youtube:dQw4w9WgXcQ`); `task` is the producing task ("fetch youtube transcript").
 *
 * The core defense (nonce framing + forgery scan + the treat-as-DATA-never-instructions
 * header) comes from the SHARED @agentruntime/untrusted-fence lib — identical to
 * web-fetch-cartridge and quarantine. The optional `prov` adds the youtube-specific
 * provenance lines (auto-caption warning, lang, title) the README promises to surface —
 * each cleaned via cleanHeaderField since the title is uploader-controlled.
 */
export function fenceContent(
  text: string,
  source: string,
  task: string,
  prov?: YoutubeProvenance,
): FenceContentResult {
  const nonce = mintNonce();
  const scanned = scanForgeries(text, nonce);

  // The shared fence's SanitizeReport is structurally identical to youtube's
  // SanitizeReport ({removed, kinds}); pass the real report through if we have it.
  const sanitize: SanitizeReport = prov?.sanitize ?? { removed: 0, kinds: [] };

  let fenced = fenceUntrusted(scanned.sanitized, nonce, {
    source,
    task,
    shape: "text",
    sanitize,
    forgeries: scanned.forgeries,
  });

  // Splice the youtube-specific provenance into the header (between the boilerplate and
  // the opening tag) so the auto-caption lossiness + title are surfaced, never silent.
  // The shared fence builds: <header>\n<openTag>\n<content>\n<closeTag>. We insert our
  // lines just before the openTag, identified as the first <untrusted- delimiter line.
  // The title is UPLOADER-CONTROLLED and lands in the header (above the fence), so it is
  // cleaned via cleanHeaderField — the lib's oneLine never sees it (spliced post-fence).
  if (prov) {
    const extra: string[] = [];
    if (prov.title) {
      const t = cleanHeaderField(prov.title);
      if (t.trim().length > 0) extra.push(`title: ${t}`);
    }
    extra.push(`lang: ${cleanHeaderField(prov.lang)}`);
    if (prov.auto) {
      extra.push(
        "warning: captions are AUTO-GENERATED (machine ASR) and may contain transcription errors.",
      );
    }
    if (extra.length > 0) {
      const openTag = `<untrusted-${nonce}>`;
      const idx = fenced.indexOf(openTag);
      if (idx >= 0) {
        // Insert the extra header lines (each on its own line) before the open tag.
        fenced = fenced.slice(0, idx) + extra.join("\n") + "\n" + fenced.slice(idx);
      }
    }
  }

  return { fenced, nonce, forgeries: scanned.forgeries };
}
