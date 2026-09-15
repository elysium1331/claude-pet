const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { resolveServedFile } = require('../src/main/served-files');

const root = path.resolve('/app');
const userPets = path.resolve('/profile/pets');
const mounts = [
  { prefix: 'src/renderer/', dir: path.join(root, 'src', 'renderer') },
  { prefix: 'pets/', dir: path.join(root, 'pets') },
  { prefix: 'user-pets/', dir: userPets },
];

test('resolveServedFile maps each mount onto its folder', () => {
  assert.equal(resolveServedFile('/src/renderer/pet.html', mounts), path.join(root, 'src', 'renderer', 'pet.html'));
  assert.equal(resolveServedFile('/pets/celestial-fox/celestial-fox.riv', mounts), path.join(root, 'pets', 'celestial-fox', 'celestial-fox.riv'));
  assert.equal(resolveServedFile('/user-pets/my%20owl/owl.riv', mounts), path.join(userPets, 'my owl', 'owl.riv'));
});

test('resolveServedFile refuses paths that escape their folder or match no mount', () => {
  for (const bad of [
    '/src/main/main.js',
    '/pets/../src/main/main.js',
    '/pets/%2e%2e/src/main/preload.js',
    '/pets/..%5C..%5Cpackage.json',
    '/user-pets/../config.json',
    '/user-pets/',
    '/pets',
    '/petsx/fox.riv',
    '/pets/%E0%A4%A',
  ]) {
    assert.equal(resolveServedFile(bad, mounts), null, bad);
  }
});
