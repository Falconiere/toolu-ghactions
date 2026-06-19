import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mintAppToken, normalizeKey } from "@/github/appToken.js";
import type {
  AppAuthFactory,
  OctokitFactory,
  InstallationLookupClient,
} from "@/github/appToken.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// REAL RSA key (generated per run, never committed) + the REAL recorded
// installation payload — no fabricated GitHub data, no network. The auth/octokit
// factories are injected and assert the args the mint issues them with.
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "app");

/** A real PEM, freshly generated so we exercise the actual PKCS#8 parse path. */
function realPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return privateKey;
}

/** The recorded `GET /repos/{owner}/{repo}/installation` body. */
function installationFixture(): { id: number } {
  return JSON.parse(readFileSync(join(FIXTURES, "installation.json"), "utf8"));
}

/** Build the injected factories, recording the args each is called with. */
function recordingSeams(token: string): {
  authFactory: AppAuthFactory;
  octokitFactory: OctokitFactory;
  calls: {
    authFactoryArgs?: { appId: string; privateKey: string };
    installArgs?: { type: string; installationId: number };
    lookupArgs?: { owner: string; repo: string };
    octokitFactoryArgs?: { appId: string; privateKey: string };
  };
} {
  const calls: ReturnType<typeof recordingSeams>["calls"] = {};
  const installation = installationFixture();

  const authFactory: AppAuthFactory = (options) => {
    calls.authFactoryArgs = options;
    return async (installOptions) => {
      calls.installArgs = installOptions;
      return { token };
    };
  };

  const octokitFactory: OctokitFactory = (options) => {
    calls.octokitFactoryArgs = options;
    const client: InstallationLookupClient = {
      rest: {
        apps: {
          getRepoInstallation: async (params) => {
            calls.lookupArgs = params;
            return { data: { id: installation.id } };
          },
        },
      },
    };
    return client;
  };

  return { authFactory, octokitFactory, calls };
}

describe("normalizeKey", () => {
  it("passes a raw PEM through unchanged", () => {
    const pem = realPem();
    expect(normalizeKey(pem)).toBe(pem);
  });

  it("decodes a base64-encoded PEM back to the raw PEM", () => {
    const pem = realPem();
    const b64 = Buffer.from(pem, "utf8").toString("base64");
    expect(normalizeKey(b64)).toBe(pem);
  });

  it("decodes a base64 PEM even when wrapped across lines (whitespace stripped)", () => {
    const pem = realPem();
    const b64 = Buffer.from(pem, "utf8").toString("base64");
    const wrapped = b64.replace(/(.{64})/g, "$1\n");
    expect(normalizeKey(wrapped)).toBe(pem);
  });
});

describe("mintAppToken", () => {
  it("mints a token from a RAW PEM, issuing the lookup + install with the right args", async () => {
    const pem = realPem();
    const { authFactory, octokitFactory, calls } = recordingSeams("ghs_minted_raw");

    const token = await mintAppToken("901234", pem, "test-org/test-repo", {
      authFactory,
      octokitFactory,
    });

    expect(token).toBe("ghs_minted_raw");
    // The repo-installation lookup got the split owner/repo.
    expect(calls.lookupArgs).toEqual({ owner: "test-org", repo: "test-repo" });
    // The install token call used the installation id from the recorded payload.
    expect(calls.installArgs).toEqual({
      type: "installation",
      installationId: installationFixture().id,
    });
    // The app id + normalized key reached the auth factory.
    expect(calls.authFactoryArgs?.appId).toBe("901234");
    expect(calls.authFactoryArgs?.privateKey).toBe(pem);
  });

  it("mints a token from a BASE64-encoded PEM (auto-decoded before signing)", async () => {
    const pem = realPem();
    const b64 = Buffer.from(pem, "utf8").toString("base64");
    const { authFactory, octokitFactory, calls } = recordingSeams("ghs_minted_b64");

    const token = await mintAppToken("901234", b64, "test-org/test-repo", {
      authFactory,
      octokitFactory,
    });

    expect(token).toBe("ghs_minted_b64");
    // The DECODED PEM (not the base64) is what auth-app receives.
    expect(calls.authFactoryArgs?.privateKey).toBe(pem);
  });

  it("returns null when NEITHER credential is set (no App configured)", async () => {
    const { authFactory, octokitFactory } = recordingSeams("unused");
    const token = await mintAppToken("", "", "test-org/test-repo", { authFactory, octokitFactory });
    expect(token).toBeNull();
  });

  it("returns null when only the app id is set (misconfiguration)", async () => {
    const { authFactory, octokitFactory } = recordingSeams("unused");
    const token = await mintAppToken("901234", "", "test-org/test-repo", {
      authFactory,
      octokitFactory,
    });
    expect(token).toBeNull();
  });

  it("returns null when only the private key is set (misconfiguration)", async () => {
    const { authFactory, octokitFactory } = recordingSeams("unused");
    const token = await mintAppToken("", realPem(), "test-org/test-repo", {
      authFactory,
      octokitFactory,
    });
    expect(token).toBeNull();
  });

  it("returns null (never throws) when the installation lookup fails", async () => {
    const octokitFactory: OctokitFactory = () => ({
      rest: {
        apps: {
          getRepoInstallation: async () => {
            throw new Error("Not Found");
          },
        },
      },
    });
    const token = await mintAppToken("901234", realPem(), "test-org/test-repo", { octokitFactory });
    expect(token).toBeNull();
  });
});
