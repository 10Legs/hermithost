import * as http from 'http';

export function dockerGet(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { socketPath: '/var/run/docker.sock', path, headers: { Host: 'localhost' } },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error(`Docker API parse error: ${body.slice(0, 200)}`)); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('Docker API timeout')); });
  });
}

export function dockerDelete(path: string): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath: '/var/run/docker.sock',
      path,
      method: 'DELETE',
      headers: { Host: 'localhost' },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d; });
      res.on('end', () => {
        const code = res.statusCode ?? 0;
        if (code >= 200 && code < 300) {
          resolve({ statusCode: code });
        } else {
          let message = `Docker API error ${code}`;
          try { message = (JSON.parse(body) as { message?: string }).message ?? message; } catch {}
          reject(new Error(message));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Docker API timeout')); });
    req.end();
  });
}

export function dockerPost(path: string, body?: object): Promise<{ statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const options: http.RequestOptions = {
      socketPath: '/var/run/docker.sock',
      path,
      method: 'POST',
      headers: {
        Host: 'localhost',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = http.request(options, (res) => {
      let responseBody = '';
      res.on('data', (d: Buffer) => { responseBody += d; });
      res.on('end', () => {
        // Docker returns 204 No Content for start/stop/restart
        resolve({ statusCode: res.statusCode });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('Docker API timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}
