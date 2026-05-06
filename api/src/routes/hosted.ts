import { Router, Request, Response } from 'express';
import { deployFromGitHub, listDeployedSites, getDeployedSite } from '../services/githubDeploy';

const router = Router();

// POST /api/hosted — deploy a GitHub repo
// Body: { githubUrl: string }
router.post('/', (req: Request, res: Response) => {
  const { githubUrl } = req.body as { githubUrl?: string };
  if (!githubUrl) {
    res.status(400).json({ error: 'githubUrl is required' });
    return;
  }
  try {
    const site = deployFromGitHub(githubUrl);
    const port = process.env.PORT ?? 3001;
    const baseUrl = `http://${req.hostname}:${port}`;
    res.status(201).json({
      ...site,
      url: `${baseUrl}/hosted/${site.slug}/`,
    });
  } catch (err) {
    console.error('[githubDeploy] deploy failed:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/hosted — list all deployed sites
router.get('/', (_req: Request, res: Response) => {
  res.status(200).json(listDeployedSites());
});

// GET /api/hosted/:slug — single deployed site info
router.get('/:slug', (req: Request, res: Response) => {
  const site = getDeployedSite(req.params.slug);
  if (!site) {
    res.status(404).json({ error: 'Site not found' });
    return;
  }
  res.status(200).json(site);
});

export default router;
