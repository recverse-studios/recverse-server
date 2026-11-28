/**
 * RecVerse Server - Economy Service Route (Cloudflare Workers)
 * Balances, purchases, inventory - compatible with February 2023 client
 */

import { Hono } from 'hono';
import { dbGet, dbRun, dbAll, isDbInitialized } from '../db/hyperdrive.js';
import { authMiddleware } from '../auth/middleware.js';
import config from '../config.js';

const router = new Hono();

// GET /api/storefronts/v4/balance/:type
router.get('/api/storefronts/v4/balance/:type', authMiddleware, async (c) => {
  const { type } = c.req.param();
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  const balance = await dbGet(
    'SELECT * FROM balances WHERE account_id = ? AND currency_type = ? AND platform = -2',
    [accountId, parseInt(type, 10)]
  );
  
  return c.json({
    accountId,
    currencyType: parseInt(type, 10),
    platform: -2,
    amount: balance ? balance.amount : 0,
    updatedAt: balance?.updated_at || new Date().toISOString(),
  });
});

// POST /api/items/bulkpurchase
router.post('/api/items/bulkpurchase', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { lines } = body;
  
  if (!isDbInitialized()) {
    return c.json({ error: 'Database not available' }, 500);
  }
  
  // Process purchase lines
  const purchased = [];
  for (const line of lines || []) {
    if (line.itemType === 0) {
      // Catalog item purchase
      purchased.push({
        itemType: 0,
        itemId: line.itemId,
        quantity: line.quantity || 1,
        price: line.price || 0,
      });
    } else if (line.itemPurchaseMethodId?.type === 1) {
      // Custom avatar item purchase
      purchased.push({
        itemType: 1,
        itemId: line.itemPurchaseMethodId.guid,
        quantity: 1,
        price: line.price || 0,
      });
    }
  }
  
  return c.json({
    success: true,
    purchased,
    balanceUpdates: [],
  });
});

// GET /api/avatar/v2/gifts
router.get('/api/avatar/v2/gifts', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ gifts: [] });
  }
  
  return c.json({ gifts: [] });
});

// POST /api/avatar/v2/gifts/open
router.post('/api/avatar/v2/gifts/open', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  const body = await c.req.json();
  const { giftId } = body;
  
  return c.json({ success: true, giftId, items: [] });
});

// GET /econ/customAvatarItems/v1/owned
router.get('/econ/customAvatarItems/v1/owned', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ items: [], created: [] });
  }
  
  const items = await dbAll(
    `SELECT i.* FROM custom_avatar_items i
     JOIN custom_avatar_item_ownership o ON i.id = o.custom_avatar_item_id
     WHERE o.account_id = ?`,
    [accountId]
  );
  
  return c.json({
    items: items.map(item => ({
      id: item.id,
      name: item.name,
      description: item.description,
      price: item.price,
      currencyType: item.currency_type,
      creatorAccountId: item.creator_account_id,
      currentSaves: item.current_saves ? JSON.parse(item.current_saves) : [],
      tags: item.tags ? JSON.parse(item.tags) : [],
    })),
    created: [],
  });
});

// GET /econ/inventory
router.get('/econ/inventory', authMiddleware, async (c) => {
  const accountId = c.get('accountId');
  
  if (!isDbInitialized()) {
    return c.json({ items: [] });
  }
  
  const items = await dbAll(
    'SELECT * FROM inventory WHERE account_id = ?',
    [accountId]
  );
  
  return c.json({
    items: items.map(item => ({
      id: item.id,
      itemType: item.item_type,
      itemId: item.item_id,
      data: item.data ? JSON.parse(item.data) : {},
      acquiredAt: item.acquired_at,
    })),
  });
});

export default router;
