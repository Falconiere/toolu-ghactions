// github/appToken.ts — mint a short-lived GitHub App installation token so the
// review bot posts under a custom identity ("Toolu — Code Review") instead of
// github-actions[bot]. Port of mint-app-token.sh, using @octokit/auth-app to
// build the App JWT, resolve the repo installation, and exchange it for an
// installation access token (replacing the bash openssl-JWT + curl dance).
//
// FAIL-SAFE: this returns a token on success or `null` on ANY failure — both
// credentials missing (no App configured), exactly one set (misconfiguration),
// or a mint error. The caller falls back to the default github-actions[bot]
// token on null, exactly like the bash `&&`-chain did. It NEVER throws.
//
// SECURITY: the private key is never logged. @octokit/auth-app holds it in
// memory and signs the JWT internally; no PEM ever hits stdout/stderr here.
import { createAppAuth } from "@octokit/auth-app";
import { errorMessage } from "@/errors.js";

/** The installation auth call's result — just the token field we read. */
export interface InstallationAuthResult {
  token: string;
}

/**
 * An auth function that mints an installation token. The real
 * {@link createAppAuth} returns a richly-overloaded `AuthInterface`; we only ever
 * call its installation overload, so this narrow shape is what the seam types —
 * a test fake satisfies it without reconstructing every overload.
 */
export type InstallationAuth = (options: {
  type: "installation";
  installationId: number;
}) => Promise<InstallationAuthResult>;

/**
 * Authentication strategy factory — `createAppAuth` in prod, injectable so tests
 * can assert the app/installation it is called with and return a fake token
 * without signing real JWTs or hitting the network.
 */
export type AppAuthFactory = (options: { appId: string; privateKey: string }) => InstallationAuth;

/**
 * The slice of an Octokit REST client appToken needs: just the repo-installation
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
 * is `getOctokit(jwt-auth)`; the App JWT is produced by {@link AppAuthFactory}.
 */
export type OctokitFactory = (authStrategy: {
  appId: string;
  privateKey: string;
}) => InstallationLookupClient;

/** Test seams for {@link mintAppToken}; the auth factory defaults to the real one. */
export interface MintAppTokenSeams {
  /** Auth-strategy factory (default a {@link createAppAuth} adapter). */
  authFactory?: AppAuthFactory;
  /** Installation-lookup client factory (default a real @actions/github Octokit). */
  octokitFactory: OctokitFactory;
}

/** Adapt the richly-overloaded createAppAuth into the narrow {@link AppAuthFactory}. */
const defaultAuthFactory: AppAuthFactory = (options) => {
  const auth = createAppAuth({ appId: options.appId, privateKey: options.privateKey });
  return (installOptions) => auth(installOptions);
};

/**
 * Detect a raw PEM vs a base64-encoded PEM and return the raw PEM either way.
 *
 * A raw PEM carries the "-----BEGIN" header; otherwise the input is treated as
 * base64 (whitespace stripped, then decoded) and the decoded text is used ONLY
 * when it is itself a PEM. Anything else falls through unchanged so the mint
 * fails with a clear downstream error — mirrors normalize_key in the bash.
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
 * Mint a GitHub App installation token for `repo` ("owner/repo").
 *
 * Returns the installation token on success, or `null` when no App is configured
 * (both inputs empty), when exactly one input is set (misconfiguration), or when
 * any step of the mint fails. Never throws and never logs the private key.
 *
 * @param appId - the GitHub App ID (numeric string); empty means unset.
 * @param privateKey - the App private key, raw PEM OR base64-encoded PEM.
 * @param repo - "owner/repo" used to resolve the installation.
 * @param seams - injected auth/octokit factories for testing.
 */
export async function mintAppToken(
  appId: string,
  privateKey: string,
  repo: string,
  seams: MintAppTokenSeams,
): Promise<string | null> {
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
    console.warn(`[WARN] App token mint failed: GITHUB_REPOSITORY is not 'owner/repo' ('${repo}')`);
    return null;
  }

  const pem = normalizeKey(privateKey);
  const authFactory = seams.authFactory ?? defaultAuthFactory;

  try {
    // App-level auth (JWT) used only to resolve the installation. The private
    // key lives inside the auth object; it is never read back or logged.
    const appAuth = authFactory({ appId, privateKey: pem });
    const octokit = seams.octokitFactory({ appId, privateKey: pem });

    const installation = await octokit.rest.apps.getRepoInstallation({ owner, repo: name });
    const installationId = installation.data.id;
    if (!installationId) {
      console.warn("[WARN] App token mint failed: no installation id in response");
      return null;
    }

    // Exchange for an installation access token.
    const token = await appAuth({ type: "installation", installationId });
    if (!token.token) {
      console.warn("[WARN] App token mint failed: no token in access-token response");
      return null;
    }
    return token.token;
  } catch (err) {
    console.warn(`[WARN] App token mint failed: ${errorMessage(err)}`);
    return null;
  }
}
