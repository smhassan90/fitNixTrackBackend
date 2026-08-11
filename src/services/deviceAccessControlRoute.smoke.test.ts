import test from 'node:test';
import assert from 'node:assert/strict';
import express, { Request, Response, NextFunction } from 'express';
import { accessControlOfflineSchema } from '../validations/device';

/**
 * Smoke-test validation + response shape for access-control-offline
 * without needing DB / ZK device.
 */

test('accessControlOfflineSchema accepts api key body', () => {
  const parsed = accessControlOfflineSchema.parse({
    params: { id: '3' },
    body: {
      apiKey: 'fnx_test_key',
      activeGroup: '1',
      blockedGroup: '2',
    },
  });
  assert.equal(parsed.params.id, 3);
  assert.equal(parsed.body.activeGroup, '1');
  assert.equal(parsed.body.blockedGroup, '2');
});

test('accessControlOfflineSchema coerces device id', () => {
  const parsed = accessControlOfflineSchema.parse({
    params: { id: '12' },
    body: {},
  });
  assert.equal(parsed.params.id, 12);
});

test('mini express handler returns blocked/allowed payload shape', async () => {
  const app = express();
  app.use(express.json());

  // Mimic authenticateApiKey success
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).deviceId = 3;
    (req as any).gymId = 3;
    next();
  });

  app.post('/api/device/:id/access-control-offline', (req, res) => {
    const deviceId = Number(req.params.id);
    const payload = {
      deviceConfigId: deviceId,
      gymId: (req as any).gymId,
      blocked: [
        {
          deviceUserId: '10',
          memberId: 1,
          memberName: 'Ali',
          deviceUserName: 'Ali',
          reason: 'overdue',
        },
      ],
      allowed: [
        {
          deviceUserId: '11',
          memberId: 2,
          memberName: 'Sara',
          deviceUserName: 'Sara',
        },
      ],
      groups: {
        active: req.body?.activeGroup || '1',
        blocked: req.body?.blockedGroup || '2',
      },
      message: 'Access control: 1 blocked, 1 allowed',
    };
    res.json({ success: true, data: payload });
  });

  const server = app.listen(0);
  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const port = addr.port;
    const res = await fetch(`http://127.0.0.1:${port}/api/device/3/access-control-offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'x', activeGroup: '1', blockedGroup: '2' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.success, true);
    assert.equal(body.data.blocked.length, 1);
    assert.equal(body.data.blocked[0].reason, 'overdue');
    assert.equal(body.data.allowed.length, 1);
    assert.deepEqual(body.data.groups, { active: '1', blocked: '2' });
  } finally {
    server.close();
  }
});
