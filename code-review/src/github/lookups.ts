// github/lookups.ts — the live GitHub lookups the settle recompute depends on, shared by
// the review action (main.ts) and merge-gate's recompute (gate/settleCheckCli.ts). Each
// THROWS on an API error; the callers treat a throw as "not authorized" / "head
// unknown" and fail closed.

/** The Octokit REST slice these lookups use. */
export interface LookupClient {
  rest: {
    repos: {
      getCollaboratorPermissionLevel(params: {
        owner: string;
        repo: string;
        username: string;
      }): Promise<{ data: { permission: string } }>;
    };
    pulls: {
      get(params: {
        owner: string;
        repo: string;
        pull_number: number;
      }): Promise<{ data: { head: { sha: string }; base: { ref: string } } }>;
    };
  };
}

/** Repository coordinates. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/** A commenter's repo permission via the collaborators API. */
export function permissionLookup(client: LookupClient, repo: RepoRef) {
  return async (login: string): Promise<string> => {
    const { data } = await client.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username: login,
    });
    return data.permission;
  };
}

/** A PR's base ref via the pulls API. */
export function baseRefLookup(client: LookupClient, repo: RepoRef) {
  return async (prNumber: number): Promise<string> => {
    const { data } = await client.rest.pulls.get({ ...repo, pull_number: prNumber });
    return data.base.ref;
  };
}

/** A PR's LIVE head sha via the pulls API (the settle freshness check). */
export function headShaLookup(client: LookupClient, repo: RepoRef) {
  return async (prNumber: number): Promise<string> => {
    const { data } = await client.rest.pulls.get({ ...repo, pull_number: prNumber });
    return data.head.sha;
  };
}
