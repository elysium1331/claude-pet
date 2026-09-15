// Builds build/icon.png (512x512) from the pet preview. Run with: npx electron build/make-icon.js
const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(path.join(__dirname, '..', 'pets', 'celestial-fox', 'preview-dark.png'));
  const { width, height } = source.getSize();
  const side = Math.min(width, height);
  const square = source.crop({ x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side });
  fs.writeFileSync(path.join(__dirname, 'icon.png'), square.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  console.log('wrote build/icon.png');
  app.quit();
});
