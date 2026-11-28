/**
 * RecVerse CDN Service
 * Serves saved images (avatars, banners, room images, etc.) via subdomain
 */

import express from 'express';
import { dbGet, isDbInitialized } from '../../verse-db.js';
import logger from '../../verse-logger.js';

const router = express.Router();

// In-memory cache for recently served images
const imageCache = new Map();
const MAX_CACHE_SIZE = 100;

/**
 * Serve an image by filename from the database
 */
async function serveImageByFilename(filename, res) {
  if (!filename) {
    return res.status(400).json({ error: 'filename required' });
  }

  // Check cache first
  const cached = imageCache.get(filename);
  if (cached) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buffer);
  }

  try {
    // Ensure DB is initialized
    await new Promise(resolve => {
      const checkDb = setInterval(() => {
        if (isDbInitialized()) {
          clearInterval(checkDb);
          resolve();
        }
      }, 10);
    });

    const row = await dbGet(
      'SELECT filename, thumbnail_filename FROM saved_images WHERE filename = ?',
      [filename]
    );

    if (!row) {
      // Try thumbnail filename
      const thumbRow = await dbGet(
        'SELECT filename FROM saved_images WHERE thumbnail_filename = ?',
        [filename]
      );
      if (thumbRow) {
        return serveImageByFilename(thumbRow.filename, res);
      }
      return res.status(404).json({ error: 'Image not found' });
    }

    // In a real deployment, the image bytes would come from object storage (S3, R2, etc.)
    // For now, we return a placeholder SVG indicating the image exists
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
        <rect width="200" height="200" fill="#e2e8f0"/>
        <text x="100" y="100" font-family="Arial" font-size="14" fill="#64748b" text-anchor="middle">
          Image: ${filename}
        </text>
        <text x="100" y="120" font-family="Arial" font-size="12" fill="#94a3b8" text-anchor="middle">
          RecVerse CDN
        </text>
      </svg>
    `.trim();

    const buffer = Buffer.from(svg, 'utf8');

    // Cache the result
    if (imageCache.size >= 100) {
      const firstKey = imageCache.keys().next().value;
      imageCache.delete(firstKey);
    }
    imageCache.set(filename, { buffer, contentType: 'image/svg+xml' });

    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    logger.error('CDN', 'Failed to serve image', { filename, error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

// CDN routes - serve images by filename
router.get('/:filename', async (req, res) => {
  const { filename } = req.params;
  logger.debug('CDN', `Serving image: ${filename}`);
  await serveImageByFilename(filename, res);
});

// CDN health check
router.get('/health', (req, res) => {
  res.json({ service: 'cdn', status: 'ok', note: 'CDN subdomain routing active' });
});

module.exports = router;