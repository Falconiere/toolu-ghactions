// github/appToken.ts — resolve a GitHub App's repository installation id so the
// review bot can post under a custom identity ("Toolu — Code Review") instead of
// github-actions[bot]. Port of mint-app-token.sh's lookup half.
//
// WHY ONLY THE ID: the caller hands this id to @octokit/auth-app as the RUNTIME
// auth strategy (main.ts), and auth-app then mints and refreshes installation
// tokens itself. Minting one token up front and passing the string instead expires
// after an hour — MAX_WALL_MS: 0 has no ceiling, so a long chunked review would
// reach its publish phase with a dead token and lose the comment, the label and
// the report after the model work was already paid for.
//
// FAIL-SAFE: returns an installation id on success or `null` on ANY failure — both
// credentials missing (no App configured), exactly one set (misconfiguration), a
// malformed GITHUB_REPOSITORY, or a lookup error. The caller falls back to the
// default github-actions[bot] token on null, exactly like the bash `&&`-chain did.
// It NEVER throws.
//
// SECURITY: the private key is never logged. It only ever reaches auth-app, which
// holds it in memory and signs the JWT internally; no PEM hits stdout/stderr here.
import { errorMessage } from "@/errors.js";

/**
 * The slice of an Octokit REST client this needs: just the repo-installation
 * lookup. A test passes a recording fake fed a REAL `GET /repos/{}/installation`
 * payload; prod passes the @actions/github Octokit (its `.rest` matches this).
 */
export interface InstallationLookupClient {
  rest: {
    apps: {
      getRepoInstallation(params: {
        owner: string;
        repo: string;
      }): Promise<{ data: { id: number } }>;
    };
  };
}

/**
 * Factory that builds an {@link InstallationLookupClient} authenticated as the
 * App (JWT auth). Injectable so tests can return a recording fake. In prod this
 * is `getOctokit(jwt-auth)`; the App JWT is produced by @octokit/auth-app from
 * the normalized key this module hands it.
 */
export type OctokitFactory = (authStrategy: {
  appId: string;
  privateKey: string;
}) => InstallationLookupClient;

/** Test seams for {@link resolveInstallationId}. */
export interface InstallationIdSeams {
  /** Installation-lookup client factory (prod: a real @actions/github Octokit). */
  octokitFactory: OctokitFactory;
}

/**
 * Detect a raw PEM vs a base64-encoded PEM and return the raw PEM either way.
 *
 * A raw PEM carries the "-----BEGIN" header; otherwise the input is treated as
 * base64 (whitespace stripped, then decoded) and the decoded text is used ONLY
 * when it is itself a PEM. Anything else falls through unchanged so auth fails
 * with a clear downstream error — mirrors normalize_key in the bash. Idempotent,
 * so a caller may normalize before passing the key in.
 */
export function normalizeKey(key: string): string {
  if (key.includes("-----BEGIN")) return key;
  try {
    const decoded = Buffer.from(key.replace(/\s+/g, ""), "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded;
  } catch {
    // fall through to the original input
  }
  return key;
}

/**
 * Resolve the GitHub App installation id for `repo` ("owner/repo").
 *
 * Returns the installation id on success, or `null` when no App is configured
 * (both inputs empty), when exactly one input is set (misconfiguration), when
 * GITHUB_REPOSITORY is not "owner/repo", or when the lookup fails. Never throws
 * and never logs the private key.
 *
 * @param appId - the GitHub App ID (numeric string); empty means unset.
 * @param privateKey - the App private key, raw PEM OR base64-encoded PEM.
 * @param repo - "owner/repo" whose installation to resolve.
 * @param seams - injected octokit factory for testing.
 */
export async function resolveInstallationId(
  appId: string,
  privateKey: string,
  repo: string,
  seams: InstallationIdSeams,
): Promise<number | null> {
  // No App configured at all → silent fall-back to the default token.
  if (!appId && !privateKey) return null;
  // Exactly one credential set → misconfiguration; warn and fall back.
  if (!appId || !privateKey) {
    console.warn(
      "[WARN] APP_ID and APP_PRIVATE_KEY must both be set; falling back to github-actions[bot]",
    );
    return null;
  }
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    console.warn(
      `[WARN] App installation lookup failed: GITHUB_REPOSITORY is not 'owner/repo' ('${repo}')`,
    );
    return null;
  }

  const pem = normalizeKey(privateKey);

  try {
    // App-level auth (JWT) used only to resolve the installation. The private
    // key lives inside the auth object; it is never read back or logged.
    const octokit = seams.octokitFactory({ appId, privateKey: pem });
    const installation = await octokit.rest.apps.getRepoInstallation({ owner, repo: name });
    const installationId = installation.data.id;
    if (!installationId) {
      console.warn("[WARN] App installation lookup failed: no installation id in response");
      return null;
    }
    return installationId;
  } catch (err) {
    console.warn(`[WARN] App installation lookup failed: ${errorMessage(err)}`);
    return null;
  }
}
