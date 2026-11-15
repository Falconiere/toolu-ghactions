import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { resolveInstallationId, normalizeKey } from "@/github/appToken.js";
import type { OctokitFactory, InstallationLookupClient } from "@/github/appToken.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// REAL RSA key (generated per run, never committed) + the REAL recorded
// installation payload — no fabricated GitHub data, no network. The octokit
// factory is injected and records the args the lookup issues it with.
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

/** Build the injected factory, recording the args it is called with. */
function recordingSeams(): {
  octokitFactory: OctokitFactory;
  calls: {
    lookupArgs?: { owner: string; repo: string };
    octokitFactoryArgs?: { appId: string; privateKey: string };
  };
} {
  const calls: {
    lookupArgs?: { owner: string; repo: string };
    octokitFactoryArgs?: { appId: string; privateKey: string };
  } = {};
  const installation = installationFixture();

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

  return { octokitFactory, calls };
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

describe("resolveInstallationId", () => {
  it("resolves the id from a RAW PEM, issuing the lookup with the right args", async () => {
    const pem = realPem();
    const { octokitFactory, calls } = recordingSeams();

    const id = await resolveInstallationId("901234", pem, "test-org/test-repo", { octokitFactory });

    expect(id).toBe(installationFixture().id);
    // The repo-installation lookup got the split owner/repo.
    expect(calls.lookupArgs).toEqual({ owner: "test-org", repo: "test-repo" });
    // The app id + normalized key reached the auth factory.
    expect(calls.octokitFactoryArgs?.appId).toBe("901234");
    expect(calls.octokitFactoryArgs?.privateKey).toBe(pem);
  });

  it("resolves from a BASE64-encoded PEM (decoded before it reaches auth-app)", async () => {
    const pem = realPem();
    const b64 = Buffer.from(pem, "utf8").toString("base64");
    const { octokitFactory, calls } = recordingSeams();

    const id = await resolveInstallationId("901234", b64, "test-org/test-repo", { octokitFactory });

    expect(id).toBe(installationFixture().id);
    // The DECODED PEM (not the base64) is what auth-app receives.
    expect(calls.octokitFactoryArgs?.privateKey).toBe(pem);
  });

  it("returns null when NEITHER credential is set (no App configured)", async () => {
    const { octokitFactory, calls } = recordingSeams();
    const id = await resolveInstallationId("", "", "test-org/test-repo", { octokitFactory });
    expect(id).toBeNull();
    // No App configured must not even attempt a lookup.
    expect(calls.lookupArgs).toBeUndefined();
  });

  it("returns null when only the app id is set (misconfiguration)", async () => {
    const { octokitFactory } = recordingSeams();
    const id = await resolveInstallationId("901234", "", "test-org/test-repo", { octokitFactory });
    expect(id).toBeNull();
  });

  it("returns null when only the private key is set (misconfiguration)", async () => {
    const { octokitFactory } = recordingSeams();
    const id = await resolveInstallationId("", realPem(), "test-org/test-repo", { octokitFactory });
    expect(id).toBeNull();
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
    const id = await resolveInstallationId("901234", realPem(), "test-org/test-repo", {
      octokitFactory,
    });
    expect(id).toBeNull();
  });

  it("returns null when GITHUB_REPOSITORY is not 'owner/repo'", async () => {
    const { octokitFactory, calls } = recordingSeams();
    const id = await resolveInstallationId("901234", realPem(), "not-a-repo", { octokitFactory });
    expect(id).toBeNull();
    expect(calls.lookupArgs).toBeUndefined();
  });

  it("returns null when the lookup response carries no installation id", async () => {
    const octokitFactory: OctokitFactory = () => ({
      rest: { apps: { getRepoInstallation: async () => ({ data: { id: 0 } }) } },
    });
    const id = await resolveInstallationId("901234", realPem(), "test-org/test-repo", {
      octokitFactory,
    });
    expect(id).toBeNull();
  });
});
