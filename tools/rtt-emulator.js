#!/usr/bin/env node
// Simple RTT-like TCP emulator for testing the extension
// Usage: node tools/rtt-emulator.js [--port 19021] [--interval 250]

const net = require('net');

const argv = require('minimist')(process.argv.slice(2));
const PORT = parseInt(argv.port || argv.p || process.env.RTT_PORT || '19021', 10);
const INTERVAL = parseInt(argv.interval || argv.i || process.env.RTT_INTERVAL || '250', 10);

function usage() {
  console.log('RTT emulator - simple TCP server that emits RTT-like lines');
  console.log('Usage: node tools/rtt-emulator.js --port 19021 --interval 250');
  process.exit(0);
}

if (argv.help || argv.h) usage();

const server = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`Client connected: ${remote}`);

  // Send a small banner so clients know it's the emulator
  socket.write(`# RTT emulator connected at ${new Date().toISOString()}\n`);

  let counter = 0;
  const id = setInterval(() => {
    // Emulate multiple channels occasionally
    const ch = (counter % 3);
    const payload = `[CH${ch}] ${new Date().toISOString()} - msg ${counter}`;
    socket.write(payload + '\n');
    counter += 1;
  }, INTERVAL);

  socket.on('close', () => {
    clearInterval(id);
    console.log(`Client disconnected: ${remote}`);
  });

  socket.on('error', (err) => {
    clearInterval(id);
    console.error(`Socket error (${remote}):`, err.message || err);
  });
});

server.on('error', (err) => {
  console.error('Server error:', err.message || err);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`RTT emulator listening on port ${PORT} (interval ${INTERVAL} ms)`);
  console.log('Connect with: nc localhost', PORT);
});
