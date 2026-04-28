import { execSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export const SITES_DIR = process.env.SITES_DIR ?? path.join(process.cwd(), 'sites');

export interface DeployedSite {
  slug: string;
  repo: string;
  branch: string;
  serveDir: string;
  deployedAt: string;
}

const deployedSites = new Map<string, DeployedSite>();

function slugFromUrl(githubUrl: string): string {
  return path.basename(githubUrl.replace(/\.git$/, ''));
}

const SERVE_CANDIDATES = ['dist', 'public', '_site', 'out', 'build'];

function detectServeDir(repoDir: string): string | null {
  // Check candidate output dirs for an index.html
  for (const candidate of SERVE_CANDIDATES) {
    const full = path.join(repoDir, candidate);
    if (
      fs.existsSync(full) &&
      fs.statSync(full).isDirectory() &&
      fs.existsSync(path.join(full, 'index.html'))
    ) {
      return full;
    }
  }
  // Fall back to repo root
  if (fs.existsSync(path.join(repoDir, 'index.html'))) {
    return repoDir;
  }
  return null;
}

function hasBuildScript(repoDir: string): boolean {
  const pkgPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { scripts?: Record<string, string> };
    return !!pkg.scripts?.build;
  } catch {
    return false;
  }
}

function injectToken(githubUrl: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return githubUrl;
  // Insert token into https URL: https://TOKEN@github.com/...
  return githubUrl.replace(/^https:\/\//, `https://${token}@`);
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;

function validateGitUrl(url: string): void {
  if (!GITHUB_URL_RE.test(url)) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }
}

function cloneOrPull(githubUrl: string, repoDir: string): void {
  const cloneUrl = injectToken(githubUrl);
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    execFileSync('git', ['remote', 'set-url', 'origin', cloneUrl], { cwd: repoDir, stdio: 'pipe' });
    execSync('git pull', { cwd: repoDir, stdio: 'pipe' });
    return;
  }
  execFileSync('git', ['clone', '--depth', '1', cloneUrl, repoDir], { stdio: 'pipe' });
}

function runBuild(repoDir: string): void {
  const hasLock = fs.existsSync(path.join(repoDir, 'package-lock.json'));
  const installCmd = hasLock ? 'npm ci' : 'npm install';
  execSync(installCmd, { cwd: repoDir, stdio: 'pipe' });
  execSync('npm run build', { cwd: repoDir, stdio: 'pipe' });
}

export function deployFromGitHub(githubUrl: string): DeployedSite {
  validateGitUrl(githubUrl);
  fs.mkdirSync(SITES_DIR, { recursive: true });

  const slug = slugFromUrl(githubUrl);
  const repoDir = path.join(SITES_DIR, slug);

  console.log(`[githubDeploy] cloning ${githubUrl} → ${repoDir}`);
  cloneOrPull(githubUrl, repoDir);

  // Detect current branch
  let branch = 'unknown';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, encoding: 'utf-8' }).trim();
  } catch {
    // ignore
  }

  // Find serve dir — build if needed
  let serveDir = detectServeDir(repoDir);
  if (!serveDir && hasBuildScript(repoDir)) {
    console.log(`[githubDeploy] running build for ${slug}`);
    runBuild(repoDir);
    serveDir = detectServeDir(repoDir);
  }

  // Last resort: serve root
  if (!serveDir) {
    serveDir = repoDir;
  }

  console.log(`[githubDeploy] ${slug} → serving from ${serveDir}`);

  const site: DeployedSite = {
    slug,
    repo: githubUrl,
    branch,
    serveDir,
    deployedAt: new Date().toISOString(),
  };

  deployedSites.set(slug, site);
  return site;
}

export function getDeployedSite(slug: string): DeployedSite | undefined {
  return deployedSites.get(slug);
}

export function listDeployedSites(): DeployedSite[] {
  return Array.from(deployedSites.values());
}
