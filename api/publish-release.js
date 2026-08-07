// Vercel endpoint to publish a GitHub Release with an uploaded ZIP asset
// POST /api/publish-release
// Headers required: x-release-tag, x-release-name, x-file-name
// Body: raw ZIP binary

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_REPO = process.env.GITHUB_REPO || 'sidx1-scratch/packager-ci';

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end('Use POST');
    return;
  }

  if (!GITHUB_TOKEN) {
    res.statusCode = 500;
    res.end('Server misconfigured: missing GITHUB_TOKEN');
    return;
  }

  const tag = req.headers['x-release-tag'];
  const name = req.headers['x-release-name'] || tag;
  const filename = req.headers['x-file-name'];
  const bodyText = req.headers['x-release-body'] || '';
  const prerelease = req.headers['x-prerelease'] === '1';

  if (!tag || !filename) {
    res.statusCode = 400;
    res.end('Missing x-release-tag or x-file-name headers');
    return;
  }

  try {
    const buffer = await readBody(req);
    // Create release or find existing
    const [owner, repo] = DEFAULT_REPO.split('/');
    const releaseApi = `https://api.github.com/repos/${owner}/${repo}/releases`;
    const headers = { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' };

    // Try to create release
    const createResp = await fetch(releaseApi, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: name, body: bodyText, draft: false, prerelease })
    });

    let release;
    if (createResp.ok) {
      release = await createResp.json();
    } else {
      // If already exists or other error, try to fetch by tag
      const tagResp = await fetch(`${releaseApi}/tags/${encodeURIComponent(tag)}`, { headers });
      if (!tagResp.ok) {
        const text = await createResp.text();
        res.statusCode = 502;
        res.end(`Failed to create or fetch release: ${createResp.status} ${createResp.statusText} - ${text}`);
        return;
      }
      release = await tagResp.json();
    }

    const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(filename)}`;
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/zip' },
      body: buffer
    });
    if (!uploadResp.ok) {
      const txt = await uploadResp.text();
      res.statusCode = 502;
      res.end(`Failed to upload asset: ${uploadResp.status} ${uploadResp.statusText} - ${txt}`);
      return;
    }
    const asset = await uploadResp.json();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ release, asset }));
  } catch (e) {
    res.statusCode = 500;
    res.end('Internal error: ' + String(e));
  }
};
