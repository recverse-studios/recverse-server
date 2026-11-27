/**
 * RecVerse Economy Service
 * Currency, storefront, purchases, inventory - compatible with February 2023 client
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');

const { requireAuth, optionalAuth, getAccountById, getAccountsByIds, defaultAccount, updateAccount } = require('./verse-auth-middleware');
const { getDb } = require('./verse-db');
const { now, sanitizeString } = require('./verse-utils');
const config = require('./verse-config');
const logger = require('./verse-logger');

const router = express.Router();

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, error: errors.array()[0].msg });
  }
  next();
};

// Currency types
const CURRENCY = {
  Tokens: 2,
  Tickets: 1,
  Gold: 100,
  Silver: 101,
};

const PLATFORM = {
  AllPlatforms: -2, // NonPurchasedNotUsableInP2P
};

/**
 * GET /health
 */
router.get('/health', (req, res) => {
  res.json({ service: 'econ', status: 'ok' });
});

/**
 * GET /api/storefronts/v4/balance/:type - Get currency balance
 */
router.get('/api/storefronts/v4/balance/:type', requireAuth, [
  param('type').isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = req.accountId;
    const currencyType = parseInt(req.params.type, 10);
    const platform = PLATFORM.AllPlatforms;
    const db = getDb();
    
    let balance = db.prepare(`
      SELECT amount FROM balances WHERE account_id = ? AND currency_type = ? AND platform = ?
    `).get(accountId, currencyType, platform);
    
    if (!balance) {
      // Initialize balance
      const initialAmount = currencyType === CURRENCY.Tokens ? 1000 : 0; // Welcome bonus
      db.prepare(`
        INSERT INTO balances (account_id, currency_type, platform, amount)
        VALUES (?, ?, ?, ?)
      `).run(accountId, currencyType, platform, initialAmount);
      balance = { amount: initialAmount };
    }
    
    // Return in client format: BalanceType is the platform (bucket key)
    res.json({
      BalanceType: platform,
      Balance: balance.amount,
      CurrencyType: currencyType,
    });
  } catch (error) {
    logger.error('ECON', 'Get balance failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/storefronts/v4/purchase - Purchase item (legacy)
 */
router.post('/api/storefronts/v4/purchase', requireAuth, [
  body('itemId').isInt(),
  body('currencyType').isInt(),
  body('price').isInt(),
  body('quantity').optional().isInt({ min: 1 }),
  validate,
], async (req, res) => {
  try {
    const accountId = req.accountId;
    const { itemId, currencyType, price, quantity = 1 } = req.body;
    const totalPrice = price * quantity;
    const platform = PLATFORM.AllPlatforms;
    const db = getDb();
    
    // Check balance
    let balance = db.prepare(`
      SELECT amount FROM balances WHERE account_id = ? AND currency_type = ? AND platform = ?
    `).get(accountId, currencyType, platform);
    
    if (!balance || balance.amount < totalPrice) {
      return res.json({ Success: false, Error: 'Insufficient funds' });
    }
    
    // Deduct balance
    const newBalance = balance.amount - totalPrice;
    db.prepare(`
      UPDATE balances SET amount = ?, updated_at = ? WHERE account_id = ? AND currency_type = ? AND platform = ?
    `).run(newBalance, now(), accountId, currencyType, platform);
    
    // Add to inventory
    db.prepare(`
      INSERT INTO inventory (account_id, item_type, item_id, data, acquired_at)
      VALUES (?, 0, ?, '{}', ?)
    `).run(accountId, itemId, now());
    
    // Send balance update frame (would go through notifications)
    
    logger.econ('Purchase', { accountId, itemId, currencyType, price: totalPrice });
    
    res.json({
      Success: true,
      BalanceUpdates: [{
        CurrencyType: currencyType,
        BalanceType: platform,
        Balance: newBalance,
        Delta: -totalPrice,
        BalanceAddType: 0,
        Data: { ItemId: itemId, Quantity: quantity },
      }],
      GiftPackage: null,
    });
  } catch (error) {
    logger.error('ECON', 'Purchase failed', { error: error.message });
    res.status(500).json({ Success: false, Error: 'Internal server error' });
  }
});

/**
 * POST /api/items/bulkpurchase - Bulk purchase (current)
 */
router.post('/api/items/bulkpurchase', requireAuth, [
  body('lines').isArray(),
  validate,
], async (req, res) => {
  try {
    const accountId = req.accountId;
    const lines = req.body.lines;
    const db = getDb();
    const platform = PLATFORM.AllPlatforms;
    const balanceUpdates = [];
    const giftPackages = [];
    
    // Calculate totals per currency
    const totals = new Map();
    for (const line of lines) {
      const currencyType = line.CurrencyType || CURRENCY.Tokens;
      const price = line.Price || 0;
      const qty = line.Quantity || 1;
      const key = currencyType;
      totals.set(key, (totals.get(key) || 0) + price * qty);
    }
    
    // Check all balances first
    for (const [currencyType, total] of totals) {
      const balance = db.prepare(`
        SELECT amount FROM balances WHERE account_id = ? AND currency_type = ? AND platform = ?
      `).get(accountId, currencyType, platform);
      
      if (!balance || balance.amount < total) {
        return res.json({ Success: false, Error: 'Insufficient funds' });
      }
    }
    
    // Process each line
    for (const line of lines) {
      const itemType = line.ItemType || 0; // 0 = catalog, 1 = custom avatar
      const itemId = line.ItemId || line.Guid;
      const currencyType = line.CurrencyType || CURRENCY.Tokens;
      const price = line.Price || 0;
      const qty = line.Quantity || 1;
      const totalPrice = price * qty;
      
      // Deduct balance
      const balance = db.prepare(`
        SELECT amount FROM balances WHERE account_id = ? AND currency_type = ? AND platform = ?
      `).get(accountId, currencyType, platform);
      
      const newBalance = balance.amount - totalPrice;
      db.prepare(`
        UPDATE balances SET amount = ?, updated_at = ? WHERE account_id = ? AND currency_type = ? AND platform = ?
      `).run(newBalance, now(), accountId, currencyType, platform);
      
      balanceUpdates.push({
        CurrencyType: currencyType,
        BalanceType: platform,
        Balance: newBalance,
        Delta: -totalPrice,
        BalanceAddType: 0,
        Data: line.Data || {},
      });
      
      // Add to inventory
      if (itemType === 0) {
        // Catalog item
        db.prepare(`
          INSERT INTO inventory (account_id, item_type, item_id, data, acquired_at)
          VALUES (?, 0, ?, '{}', ?)
        `).run(accountId, itemId, now());
        
        // Create gift package
        giftPackages.push({
          AvatarItemType: null, // Non-avatar items
          AvatarItemDesc: '',
          EquipmentPrefabName: '',
          CustomAvatarItemId: 0,
          ToPlayerId: line.ToPlayerId || accountId,
        });
      } else if (itemType === 1) {
        // Custom avatar item
        db.prepare(`
          INSERT INTO custom_avatar_item_ownership (account_id, custom_avatar_item_id, acquired_at)
          VALUES (?, ?, ?)
        `).run(accountId, itemId, now());
        
        giftPackages.push({
          AvatarItemType: 0, // Custom items have type
          AvatarItemDesc: '',
          EquipmentPrefabName: '',
          CustomAvatarItemId: itemId,
          ToPlayerId: line.ToPlayerId || accountId,
        });
      }
    }
    
    logger.econ('Bulk purchase', { accountId, lines: lines.length });
    
    res.json({
      Success: true,
      BalanceUpdates: balanceUpdates,
      GiftPackage: giftPackages[0] || null,
      GiftPackages: giftPackages,
    });
  } catch (error) {
    logger.error('ECON', 'Bulk purchase failed', { error: error.message });
    res.status(500).json({ Success: false, Error: 'Internal server error' });
  }
});

/**
 * GET /api/avatar/v2/gifts - Get gift boxes
 */
router.get('/api/avatar/v2/gifts', requireAuth, async (req, res) => {
  // Return empty for now
  res.json([]);
});

/**
 * POST /api/avatar/v2/gifts/open - Open gift box
 */
router.post('/api/avatar/v2/gifts/open', requireAuth, [
  body('giftId').isInt(),
  validate,
], async (req, res) => {
  res.json({ Success: true, Items: [] });
});

/**
 * GET /econ/customAvatarItems/v1/owned - Get owned custom avatar items
 */
router.get('/econ/customAvatarItems/v1/owned', requireAuth, [
  query('unityAssetTarget').optional().isInt(),
  validate,
], async (req, res) => {
  try {
    const accountId = req.accountId;
    const unityAssetTarget = parseInt(req.query.unityAssetTarget) || 0;
    const db = getDb();
    
    // Get owned items + created items
    const owned = db.prepare(`
      SELECT cai.* FROM custom_avatar_items cai
      JOIN custom_avatar_item_ownership o ON o.custom_avatar_item_id = cai.id
      WHERE o.account_id = ?
    `).all(accountId);
    
    const created = db.prepare(`
      SELECT * FROM custom_avatar_items WHERE creator_account_id = ?
    `).all(accountId);
    
    // Combine and deduplicate
    const allItems = [...owned, ...created];
    const uniqueItems = new Map();
    for (const item of allItems) {
      if (!uniqueItems.has(item.id)) uniqueItems.set(item.id, item);
    }
    
    const results = Array.from(uniqueItems.values()).map(item => {
      const saves = JSON.parse(item.current_saves || '[]');
      const questSaves = saves.map(save => ({
        ...save,
        UnityAsset: unityAssetTarget === 2 ? save.UnityAsset2 : save.UnityAsset,
        UnityAssetHash: unityAssetTarget === 2 ? save.UnityAsset2Hash : save.UnityAssetHash,
        UnityAsset2: undefined,
        UnityAsset2Hash: undefined,
      }));
      
      return {
        Id: item.id,
        CreatorAccountId: item.creator_account_id,
        Name: item.name,
        Description: item.description,
        BaseAvatarItemId: item.base_avatar_item_id,
        BaseAvatarItemColor: item.base_avatar_item_color,
        DesignFilename: item.design_filename,
        ThumbnailImageFilename: item.thumbnail_image_filename,
        Price: item.price,
        CurrencyType: item.currency_type,
        PurchaseCurrencyType: item.purchase_currency_type,
        OutfitType: item.outfit_type,
        CurrentSaves: questSaves,
        Tags: JSON.parse(item.tags || '[]'),
        CustomBadgeMetadata: item.custom_badge_metadata,
        CreatedAt: item.created_at,
        UpdatedAt: item.updated_at,
      };
    });
    
    res.json(results);
  } catch (error) {
    logger.error('ECON', 'Owned custom avatar items failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /econ/inventory - Get player inventory
 */
router.get('/econ/inventory', requireAuth, async (req, res) => {
  try {
    const accountId = req.accountId;
    const db = getDb();
    
    const items = db.prepare('SELECT * FROM inventory WHERE account_id = ?').all(accountId);
    
    res.json(items.map(item => ({
      Id: item.id,
      AccountId: item.account_id,
      ItemType: item.item_type,
      ItemId: item.item_id,
      Data: JSON.parse(item.data || '{}'),
      AcquiredAt: item.acquired_at,
    })));
  } catch (error) {
    logger.error('ECON', 'Get inventory failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;