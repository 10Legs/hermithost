#!/usr/bin/env node

import http from 'http';
import { execSync } from 'child_process';

const BASE_URL = 'http://localhost:9080';
// Set HERMITHOST_TEST_PASSWORD env var for local testing
const PASSWORD = process.env.HERMITHOST_TEST_PASSWORD || 'changeme';

const tests = [];
let sessionCookie = null;

// Helper to make HTTP requests
function request(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const options = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (sessionCookie) {
      options.headers.Cookie = sessionCookie;
    }

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Test 1: Login and get session cookie
async function testLogin() {
  console.log('\n=== Test 1: Login via /api/auth/login ===');
  try {
    const res = await request('POST', `${BASE_URL}/api/auth/login`, {
      password: PASSWORD,
    });

    console.log(`Status: ${res.status}`);
    if (res.status !== 200) {
      console.error(`FAIL: Expected 200, got ${res.status}`);
      tests.push({ name: 'Login', passed: false, reason: `Status ${res.status}` });
      return;
    }

    // Extract session cookie
    const setCookie = res.headers['set-cookie'];
    if (!setCookie || !Array.isArray(setCookie)) {
      console.error('FAIL: No Set-Cookie header');
      tests.push({ name: 'Login', passed: false, reason: 'No Set-Cookie header' });
      return;
    }

    const cookieMatch = setCookie[0].match(/hermithost_session=([^;]+)/);
    if (!cookieMatch) {
      console.error('FAIL: Could not extract hermithost_session cookie');
      tests.push({ name: 'Login', passed: false, reason: 'No hermithost_session cookie' });
      return;
    }

    sessionCookie = `hermithost_session=${cookieMatch[1]}`;
    console.log('✓ Login successful, session cookie obtained');
    tests.push({ name: 'Login', passed: true });
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    tests.push({ name: 'Login', passed: false, reason: err.message });
  }
}

// Test 2: GET /api/services — should return container list
async function testGetServices() {
  console.log('\n=== Test 2: GET /api/services ===');
  try {
    const res = await request('GET', `${BASE_URL}/api/services`);

    console.log(`Status: ${res.status}`);
    if (res.status !== 200) {
      console.error(`FAIL: Expected 200, got ${res.status}`);
      tests.push({ name: 'GET /api/services', passed: false, reason: `Status ${res.status}` });
      return;
    }

    const data = JSON.parse(res.body);
    console.log(`Response keys: ${Object.keys(data).join(', ')}`);
    console.log(`Stack groups: ${data.stackGroups?.length ?? 0}`);
    console.log(`Site groups: ${data.siteGroups?.length ?? 0}`);

    if (!data.stackGroups && !data.siteGroups) {
      console.error('FAIL: No stackGroups or siteGroups in response');
      tests.push({ name: 'GET /api/services', passed: false, reason: 'Missing groups' });
      return;
    }

    console.log('✓ GET /api/services returned container list');
    tests.push({ name: 'GET /api/services', passed: true });
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    tests.push({ name: 'GET /api/services', passed: false, reason: err.message });
  }
}

// Test 3: Docker proxy deny path — try to operate on unmanaged container
async function testProxyDenyPath() {
  console.log('\n=== Test 3: Proxy Deny Path (403) ===');
  try {
    // Create a temporary unmanaged container for testing
    console.log('Creating temporary unmanaged container...');
    let containerId;
    try {
      const createOut = execSync(
        'docker run -d --name qa-unmanaged-test-alpine alpine sleep 3600',
        { encoding: 'utf8', stdio: 'pipe' }
      );
      containerId = createOut.trim().slice(0, 12);
      console.log(`Created unmanaged container: ${containerId}`);
    } catch (err) {
      console.error(`Failed to create test container: ${err.message}`);
      tests.push({ name: 'Proxy Deny (403)', passed: false, reason: 'Could not create test container' });
      return;
    }

    // Try to stop it via the API (should be blocked by proxy)
    console.log(`Attempting to stop unmanaged container ${containerId} via API...`);
    const res = await request('POST', `${BASE_URL}/api/services/${containerId}/stop`);

    console.log(`Status: ${res.status}`);

    // Clean up the test container
    try {
      execSync(`docker rm -f qa-unmanaged-test-alpine`, { stdio: 'pipe' });
      console.log('Cleaned up test container');
    } catch {
      // Ignore cleanup errors
    }

    // Should get 403 Forbidden from proxy
    if (res.status === 403 || res.status === 502) {
      console.log(`✓ Proxy correctly denied operation (status ${res.status})`);
      tests.push({ name: 'Proxy Deny (403)', passed: true });
    } else {
      console.error(`FAIL: Expected 403 or 502, got ${res.status}`);
      tests.push({ name: 'Proxy Deny (403)', passed: false, reason: `Got ${res.status} instead of 403/502` });
    }
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    tests.push({ name: 'Proxy Deny (403)', passed: false, reason: err.message });
  }
}

// Test 4: Docker proxy 404 path — try to stop non-existent container
async function testProxy404Path() {
  console.log('\n=== Test 4: Proxy 404 Path ===');
  try {
    const fakeContainerId = 'nonexistent0000abc';

    console.log(`Attempting to stop non-existent container ${fakeContainerId} via API...`);
    const res = await request('POST', `${BASE_URL}/api/services/${fakeContainerId}/stop`);

    console.log(`Status: ${res.status}`);

    // Should get 502 Bad Gateway (proxy error) or 404 from API layer
    if (res.status === 404 || res.status === 502) {
      console.log(`✓ Proxy correctly returned error for non-existent container (status ${res.status})`);
      tests.push({ name: 'Proxy 404', passed: true });
    } else {
      console.error(`FAIL: Expected 404 or 502, got ${res.status}`);
      tests.push({ name: 'Proxy 404', passed: false, reason: `Got ${res.status}` });
    }
  } catch (err) {
    console.error(`FAIL: ${err.message}`);
    tests.push({ name: 'Proxy 404', passed: false, reason: err.message });
  }
}

// Run all tests
async function runTests() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Docker Socket Proxy Direct API Tests                     ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  await testLogin();
  await testGetServices();
  await testProxyDenyPath();
  await testProxy404Path();

  // Print summary
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  Test Summary                                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  const passed = tests.filter(t => t.passed).length;
  const failed = tests.filter(t => !t.passed).length;

  for (const test of tests) {
    const status = test.passed ? '✓ PASS' : '✗ FAIL';
    const reason = test.reason ? ` (${test.reason})` : '';
    console.log(`${status}: ${test.name}${reason}`);
  }

  console.log(`\nTotal: ${passed}/${tests.length} passed`);

  if (failed > 0) {
    console.log(`\n⚠ ${failed} test(s) failed`);
    process.exit(1);
  } else {
    console.log('\n✓ All tests passed');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
