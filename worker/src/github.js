// Starts the hourly GitHub Actions job (workflow_dispatch). The token is a fine-grained token
// limited to this one repository with Actions read/write.

export async function dispatchJob(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW}/dispatches`;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "axiom-news-worker",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs: { min_gap_minutes: "20" } }),
    });
  } catch (e) {
    return { ok: false, problem: `could not start the hourly job (network error: ${e.message})` };
  }
  if (resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status };
  let detail = "";
  try { detail = (await resp.json()).message ?? ""; } catch { /* no body */ }
  const why = detail ? `GitHub HTTP ${resp.status}: ${detail}` : `GitHub HTTP ${resp.status}`;
  return { ok: false, status: resp.status, problem: `could not start the hourly job (${why})` };
}
