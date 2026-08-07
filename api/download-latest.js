// Vercel serverless endpoint
// GET /api/download-latest?ext=rpm|deb&name=optional-substring&proxy=1

const DEFAULT_REPO = process.env.GITHUB_REPO || 'sidx1-scratch/packager-ci';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

module.exports = async (req, res) => {
  try {
    const { query } = req;
    const ext = (query.ext || '').toLowerCase();
    const nameFilter = query.name || '';
    const forceProxy = query.proxy === '1' || process.env.FORCE_PROXY === '1';

    if (!ext || !['rpm', 'deb'].includes(ext)) {
      res.statusCode = 400;
      res.end('Provide ext=rpm or ext=deb');
      return;
    }

    const repo = DEFAULT_REPO;
    const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
    const headers = { 'Accept': 'application/vnd.github+json' };
    if (GITHUB_TOKEN) headers['Authorization'] = `token ${GITHUB_TOKEN}`;

    const r = await fetch(apiUrl, { headers });
    if (!r.ok) {
      res.statusCode = 502;
      res.end(`Failed to fetch release: ${r.status} ${r.statusText}`);
      return;
    }
    const release = await r.json();
    const assets = release.assets || [];

    const candidates = assets.filter(a => a.name && a.name.toLowerCase().endsWith('.' + ext) && a.name.includes(nameFilter));
    if (candidates.length === 0) {
      res.statusCode = 404;
      res.end('No matching asset found');
      return;
    }

    // Prefer exact match or pick the first
    let asset = candidates.find(a => a.name.toLowerCase().endsWith('.' + ext));
    if (!asset) asset = candidates[0];

    const downloadUrl = asset.browser_download_url;

    // If we have a token or proxy requested, fetch and stream the asset back
    if (GITHUB_TOKEN || forceProxy) {
      const dlHeaders = {};
      if (GITHUB_TOKEN) dlHeaders['Authorization'] = `token ${GITHUB_TOKEN}`;
      const resp = await fetch(downloadUrl, { headers: dlHeaders });
      if (!resp.ok) {
        res.statusCode = 502;
        res.end(`Failed to fetch asset: ${resp.status} ${resp.statusText}`);
        return;
      }
      // Set content headers
      const ct = resp.headers.get('content-type') || 'application/octet-stream';
      const cl = resp.headers.get('content-length');
      const cd = `attachment; filename="${asset.name}"`;
      res.setHeader('Content-Type', ct);
      if (cl) res.setHeader('Content-Length', cl);
      res.setHeader('Content-Disposition', cd);

      // Stream the body to the client
      const body = resp.body;
      if (body && typeof body.pipe === 'function') {
        body.pipe(res);
      } else {
        // Fallback: read as arrayBuffer
        const ab = await resp.arrayBuffer();
        res.end(Buffer.from(ab));
      }
      return;
    }

    // Otherwise redirect to the public browser_download_url
    res.writeHead(302, { Location: downloadUrl });
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.end('Internal error: ' + String(e));
  }
};
