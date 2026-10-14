const path = require('path');
const crypto = require('crypto');
const express = require('express');

const DEFAULT_ORIGINS = [
  'http://localhost:4173',
  'http://localhost:5173',
  'hub://dashboard',
];

const resolveHost = (env = process.env) => env.HOST || '127.0.0.1';

function cors(origins = DEFAULT_ORIGINS) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

function keyGate(secret) {
  const expected = Buffer.from(secret);
  return (req, res, next) => {
    const supplied = Buffer.from(req.get('X-Api-Key') || '');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
}

function mountDashboard(app, secret, distDir) {
  const gate = keyGate(secret);
  app.use(gate);
  app.use(express.static(distDir, { index: false }));
  app.get('*', (req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

module.exports = { DEFAULT_ORIGINS, resolveHost, cors, keyGate, mountDashboard };
