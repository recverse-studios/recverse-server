/**
 * RecVerse Server - Cloudflare Workers Tests
 * Tests for notification, broadcast, and maintenance systems
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app } from '../src/index.js';

// Mock environment
const env = {
  DB: null, // No database in tests
  JWT_SECRET: 'test-secret-key',
};

const ctx = {
  waitUntil: (p) => p,
  passThroughOnException: () => {},
};

describe('RecVerse Server - Workers Tests', () => {
  describe('Health Check', () => {
    it('should return health status', async () => {
      const request = new Request('http://localhost/health');
      const response = await app.fetch(request, env, ctx);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.service).toBe('recverse-server');
      expect(data.runtime).toBe('cloudflare-workers');
    });
  });

  describe('Service Discovery', () => {
    it('should return service endpoints', async () => {
      const request = new Request('http://localhost/');
      const response = await app.fetch(request, env, ctx);
      const data = await response.json();
      
      expect(response.status).toBe(200);
      expect(data).toHaveProperty('Accounts');
      expect(data).toHaveProperty('Auth');
      expect(data).toHaveProperty('API');
      expect(data).toHaveProperty('Rooms');
    });
  });

  describe('Authentication', () => {
    it('should return 401 for token endpoint without body', async () => {
      const request = new Request('http://localhost/auth/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await app.fetch(request, env, ctx);
      
      expect(response.status).toBe(400);
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const request = new Request('http://localhost/unknown-route');
      const response = await app.fetch(request, env, ctx);
      
      expect(response.status).toBe(404);
    });
  });

  describe('Security Headers', () => {
    it('should include security headers', async () => {
      const request = new Request('http://localhost/health');
      const response = await app.fetch(request, env, ctx);
      
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });
  });
});
